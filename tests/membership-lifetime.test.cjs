const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { createMembershipService } = require("../app/backend/会员授权服务");

function requestJson(service, method, pathname, body = null) {
  const request = Readable.from(body === null ? [] : [Buffer.from(JSON.stringify(body), "utf8")]);
  request.method = method;
  request.headers = {};
  return new Promise((resolve, reject) => {
    let statusCode = 0;
    let responseText = "";
    const response = {
      writeHead(code) {
        statusCode = code;
      },
      end(value = "") {
        responseText += String(value);
        resolve({ statusCode, body: JSON.parse(responseText || "{}") });
      },
    };
    service.handleRequest(request, response, new URL(`http://127.0.0.1${pathname}`)).catch(reject);
  });
}

test("membership UI names the lifetime plan as custom lifetime edition", () => {
  const membershipScript = fs.readFileSync(
    path.join(__dirname, "..", "app", "assets", "js", "membership.js"),
    "utf8",
  );
  assert.match(membershipScript, /lifetime:\s*\{\s*amount:\s*"1599 元",\s*label:\s*"定制永久版"\s*\}/);
  assert.match(membershipScript, /<strong>定制永久版<\/strong><span>1599 元 \/ 永久有效<\/span>/);
  assert.doesNotMatch(membershipScript, /label:\s*"永久"/);
});

test("permanent activation is signed, device-bound, and has no expiry countdown", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ashare-membership-lifetime-"));
  const previousStateDir = process.env.A_SHARE_REVIEW_MEMBER_DATA_DIR;
  const previousClockCheck = process.env.A_SHARE_REVIEW_SKIP_CLOCK_CHECK;
  try {
    const signerKeyDir = path.join(root, "signer");
    const memberKeyDir = path.join(root, "member");
    const appDir = path.join(root, "app");
    const dataDir = path.join(appDir, "data");
    const stateDir = path.join(root, "state");
    fs.mkdirSync(signerKeyDir, { recursive: true });
    fs.mkdirSync(memberKeyDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    fs.writeFileSync(path.join(signerKeyDir, "会员私钥.pem"), privateKey);
    fs.writeFileSync(path.join(signerKeyDir, "会员公钥.pem"), publicKey);
    fs.writeFileSync(path.join(memberKeyDir, "会员公钥.pem"), publicKey);
    fs.writeFileSync(path.join(dataDir, "会员支付配置.json"), JSON.stringify({
      monthlyPrice: 72,
      annualPrice: 699,
      lifetimePrice: 1599,
    }));
    process.env.A_SHARE_REVIEW_MEMBER_DATA_DIR = stateDir;
    process.env.A_SHARE_REVIEW_SKIP_CLOCK_CHECK = "1";

    const member = createMembershipService({ edition: "member", appDir, dataDir, keyDir: memberKeyDir });
    const signer = createMembershipService({ edition: "self", appDir, dataDir, keyDir: signerKeyDir });
    const deviceCode = member.memberStatus().deviceCode;
    const generated = await requestJson(signer, "POST", "/api/v1/membership/admin/generate", {
      deviceCode,
      plan: "lifetime",
      customer: "测试会员",
    });
    assert.equal(generated.statusCode, 200);
    assert.equal(generated.body.price, 1599);
    assert.equal(generated.body.payload.plan, "lifetime");
    assert.equal(generated.body.payload.permanent, true);
    assert.equal(generated.body.payload.expiresAt, "");

    const activated = await requestJson(member, "POST", "/api/v1/membership/activate", {
      activationCode: generated.body.activationCode,
    });
    assert.equal(activated.statusCode, 200);
    assert.equal(activated.body.membership.active, true);
    assert.equal(activated.body.membership.planLabel, "定制永久版");
    assert.equal(activated.body.membership.permanent, true);
    assert.equal(activated.body.membership.expiresAt, "");
    assert.equal(activated.body.membership.remainingDays, null);

    for (const plan of ["month", "year"]) {
      process.env.A_SHARE_REVIEW_MEMBER_DATA_DIR = path.join(root, `state-${plan}`);
      const timedMember = createMembershipService({ edition: "member", appDir, dataDir, keyDir: memberKeyDir });
      const timedGenerated = await requestJson(signer, "POST", "/api/v1/membership/admin/generate", {
        deviceCode: timedMember.memberStatus().deviceCode,
        plan,
      });
      assert.equal(timedGenerated.statusCode, 200);
      assert.equal(timedGenerated.body.payload.permanent, false);
      assert.ok(Number.isFinite(Date.parse(timedGenerated.body.payload.expiresAt)));
      const timedActivated = await requestJson(timedMember, "POST", "/api/v1/membership/activate", {
        activationCode: timedGenerated.body.activationCode,
      });
      assert.equal(timedActivated.statusCode, 200);
      assert.equal(timedActivated.body.membership.active, true);
      assert.equal(timedActivated.body.membership.plan, plan);
      assert.equal(timedActivated.body.membership.permanent, false);
      assert.ok(timedActivated.body.membership.remainingDays > 0);
    }

    const plans = member.paymentConfig().plans;
    assert.deepEqual(
      plans.map(({ key, price, permanent }) => ({ key, price, permanent: permanent === true })),
      [
        { key: "month", price: 72, permanent: false },
        { key: "year", price: 699, permanent: false },
        { key: "lifetime", price: 1599, permanent: true },
      ],
    );
  } finally {
    if (previousStateDir === undefined) delete process.env.A_SHARE_REVIEW_MEMBER_DATA_DIR;
    else process.env.A_SHARE_REVIEW_MEMBER_DATA_DIR = previousStateDir;
    if (previousClockCheck === undefined) delete process.env.A_SHARE_REVIEW_SKIP_CLOCK_CHECK;
    else process.env.A_SHARE_REVIEW_SKIP_CLOCK_CHECK = previousClockCheck;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("basic edition has quantitative access but cannot issue activation codes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ashare-membership-basic-"));
  const previousStateDir = process.env.A_SHARE_REVIEW_MEMBER_DATA_DIR;
  try {
    const appDir = path.join(root, "app");
    const dataDir = path.join(appDir, "data");
    const keyDir = path.join(appDir, "backend");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(keyDir, { recursive: true });
    process.env.A_SHARE_REVIEW_MEMBER_DATA_DIR = path.join(root, "state");

    const basic = createMembershipService({ edition: "basic", appDir, dataDir, keyDir });
    const status = basic.memberStatus();
    assert.equal(status.edition, "basic");
    assert.equal(status.active, true);
    assert.equal(status.plan, "basic");
    assert.equal(status.planLabel, "基础版");
    assert.equal(status.canIssueActivation, false);
    assert.equal(basic.hasAccess(), true);

    const generated = await requestJson(basic, "POST", "/api/v1/membership/admin/generate", {
      deviceCode: status.deviceCode,
      plan: "month",
    });
    assert.equal(generated.statusCode, 403);
    assert.match(generated.body.message, /没有激活码签发权限/);

    const history = await requestJson(basic, "GET", "/api/v1/membership/admin/history");
    assert.equal(history.statusCode, 403);
    assert.match(history.body.message, /没有管理权限/);

    const payment = await requestJson(basic, "POST", "/api/v1/membership/payment/order", {
      plan: "month",
    });
    assert.equal(payment.statusCode, 400);
    assert.equal(payment.body.errorCode, "BASIC_EDITION");
  } finally {
    if (previousStateDir === undefined) delete process.env.A_SHARE_REVIEW_MEMBER_DATA_DIR;
    else process.env.A_SHARE_REVIEW_MEMBER_DATA_DIR = previousStateDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
