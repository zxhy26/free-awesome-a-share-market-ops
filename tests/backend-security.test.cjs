const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isAllowedHostHeader,
  isAllowedOrigin,
  validateLocalRequest,
} = require("../app/backend/local-request-security");

test("local service accepts only loopback host headers by default", () => {
  assert.equal(isAllowedHostHeader("127.0.0.1:18765", 18765), true);
  assert.equal(isAllowedHostHeader("localhost:18765", 18765), true);
  assert.equal(isAllowedHostHeader("[::1]:18765", 18765), true);
  assert.equal(isAllowedHostHeader("example.com:18765", 18765), false);
  assert.equal(isAllowedHostHeader("127.0.0.1:9999", 18765), false);
});

test("local service rejects remote browser origins and cross-site writes", () => {
  assert.equal(isAllowedOrigin("http://127.0.0.1:18765", 18765), true);
  assert.equal(isAllowedOrigin("https://example.com", 18765), false);
  const remoteOrigin = validateLocalRequest({
    method: "POST",
    headers: {host: "127.0.0.1:18765", origin: "https://example.com"},
  }, {port: 18765});
  assert.equal(remoteOrigin.ok, false);
  assert.equal(remoteOrigin.code, "INVALID_ORIGIN");

  const crossSite = validateLocalRequest({
    method: "POST",
    headers: {host: "127.0.0.1:18765", "sec-fetch-site": "cross-site"},
  }, {port: 18765});
  assert.equal(crossSite.ok, false);
  assert.equal(crossSite.code, "CROSS_SITE_WRITE");
});

test("same-origin browser and local native clients remain supported", () => {
  const browser = validateLocalRequest({
    method: "POST",
    headers: {
      host: "127.0.0.1:18765",
      origin: "http://127.0.0.1:18765",
      "sec-fetch-site": "same-origin",
    },
  }, {port: 18765});
  assert.equal(browser.ok, true);
  assert.equal(browser.corsOrigin, "http://127.0.0.1:18765");

  const native = validateLocalRequest({
    method: "POST",
    headers: {host: "127.0.0.1:18765"},
  }, {port: 18765});
  assert.equal(native.ok, true);
});
