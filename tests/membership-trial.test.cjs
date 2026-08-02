const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { createMembershipService } = require("../app/backend/会员授权服务");

function requestJson(service, method, pathname) {
  const request = Readable.from([]);
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

test("three-day trial is device-local, durable, one-time and unlocks protected features", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ashare-membership-trial-"));
  const previousStateDir = process.env.A_SHARE_REVIEW_MEMBER_DATA_DIR;
  const previousClockCheck = process.env.A_SHARE_REVIEW_SKIP_CLOCK_CHECK;
  try {
    const appDir = path.join(root, "app");
    const dataDir = path.join(appDir, "data");
    const keyDir = path.join(appDir, "backend");
    const stateDir = path.join(root, "member-state");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(keyDir, { recursive: true });
    process.env.A_SHARE_REVIEW_MEMBER_DATA_DIR = stateDir;
    process.env.A_SHARE_REVIEW_SKIP_CLOCK_CHECK = "1";

    const member = createMembershipService({ edition: "member", appDir, dataDir, keyDir });
    const initial = member.memberStatus();
    assert.equal(initial.active, false);
    assert.equal(initial.trialAvailable, true);
    assert.equal(initial.trialUsed, false);

    const claimed = await requestJson(member, "POST", "/api/v1/membership/trial");
    assert.equal(claimed.statusCode, 200);
    assert.equal(claimed.body.membership.active, true);
    assert.equal(claimed.body.membership.plan, "trial");
    assert.equal(claimed.body.membership.planLabel, "三天免费试用");
    assert.equal(claimed.body.membership.trialAvailable, false);
    assert.equal(claimed.body.membership.trialUsed, true);
    assert.equal(claimed.body.membership.trialActive, true);
    assert.equal(
      Date.parse(claimed.body.membership.trialExpiresAt)
        - Date.parse(claimed.body.membership.trialStartedAt),
      3 * 24 * 60 * 60 * 1000,
    );
    assert.equal(member.hasAccess(), true);

    const duplicate = await requestJson(member, "POST", "/api/v1/membership/trial");
    assert.equal(duplicate.statusCode, 409);
    assert.equal(duplicate.body.errorCode, "TRIAL_ALREADY_USED");

    const restarted = createMembershipService({ edition: "member", appDir, dataDir, keyDir });
    assert.equal(restarted.memberStatus().active, true);
    assert.equal(restarted.memberStatus().trialUsed, true);

    const now = Date.now();
    const recordPath = path.join(stateDir, "免费试用记录.json");
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    record.startedAt = new Date(now - 4 * 24 * 60 * 60 * 1000).toISOString();
    record.expiresAt = new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(recordPath, JSON.stringify(record, null, 2), "utf8");

    const expired = restarted.memberStatus();
    assert.equal(expired.active, false);
    assert.equal(expired.statusCode, "TRIAL_EXPIRED");
    assert.equal(expired.trialAvailable, false);
    assert.equal(expired.trialUsed, true);
    assert.equal(restarted.hasAccess(), false);

    const afterExpiry = await requestJson(restarted, "POST", "/api/v1/membership/trial");
    assert.equal(afterExpiry.statusCode, 409);
    assert.equal(afterExpiry.body.errorCode, "TRIAL_ALREADY_USED");
  } finally {
    if (previousStateDir === undefined) delete process.env.A_SHARE_REVIEW_MEMBER_DATA_DIR;
    else process.env.A_SHARE_REVIEW_MEMBER_DATA_DIR = previousStateDir;
    if (previousClockCheck === undefined) delete process.env.A_SHARE_REVIEW_SKIP_CLOCK_CHECK;
    else process.env.A_SHARE_REVIEW_SKIP_CLOCK_CHECK = previousClockCheck;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("trial control is member-desktop-only and calls the local authorization API", () => {
  const root = path.join(__dirname, "..");
  const index = fs.readFileSync(path.join(root, "app", "index.html"), "utf8");
  const frontend = fs.readFileSync(path.join(root, "app", "assets", "js", "membership.js"), "utf8");
  const editionBuilder = fs.readFileSync(
    path.join(root, "scripts", "apply-display-index-to-extracted-editions.mjs"),
    "utf8",
  );
  const mobileBuilder = fs.readFileSync(path.join(root, "scripts", "build-mobile-pwa.mjs"), "utf8");
  const button = index.match(/<button[^>]*id="membershipTrialButton"[^>]*>[\s\S]*?<\/button>/)?.[0] || "";

  assert.match(button, /membership-trial-button/);
  assert.match(button, /hidden/);
  assert.match(button, /免费试用3天/);
  assert.match(frontend, /fetch\("\/api\/v1\/membership\/trial"/);
  assert.match(frontend, /membership\.trialAvailable === true/);
  assert.match(frontend, /membership\.trialUsed !== true/);
  assert.match(editionBuilder, /if \(mode !== "member"\)/);
  assert.match(mobileBuilder, /membership-trial-button/);
});
