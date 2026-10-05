/**
 * End-to-end smoke test: real browsers, a real server, no mocks.
 *
 * It checks the claim the whole project rests on — that two people can talk and
 * the server cannot read them — and then walks the features that were added on
 * top: emoji, encrypted photos, pinning, key verification, threads, the chat
 * menu, the admin panel and the 404 screen.
 *
 * Usage:
 *   1) build and start the server:   ./build.sh && ./dist/kivorad
 *   2) npm --prefix web install
 *   3) node web/e2e/smoke.mjs
 *
 * Screenshots land in /tmp/shots.
 */

import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const BASE = process.env.KIVORA_BASE ?? "http://127.0.0.1:8080";
const SHOTS = process.env.KIVORA_SHOTS ?? "/tmp/shots";
const PHOTO = process.env.KIVORA_PHOTO ?? "/tmp/photo.png";
mkdirSync(SHOTS, { recursive: true });

const log = (...a) => console.log("·", ...a);
const failures = [];

function check(condition, message) {
  if (condition) log(message);
  else {
    failures.push(message);
    console.error("  ✗", message);
  }
}

async function signUp(ctx, username, displayName) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => failures.push(`[${username}] page error: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error" && !m.text().includes("favicon")) {
      console.error(`  [${username}] console:`, m.text());
    }
  });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Регистрация" }).click();
  await page.getByPlaceholder("ivan").fill(username);
  await page.locator(".auth__form input").nth(1).fill(displayName);
  await page.locator('input[type="password"]').fill("correct horse battery staple");
  await page.getByRole("button", { name: "Создать аккаунт" }).click();
  await page.waitForSelector(".shell", { timeout: 40000 });
  log(`${username}: registered and inside the app`);
  return page;
}

async function pick(page, query, expect) {
  await page.getByPlaceholder("Имя или @логин").fill(query);
  await page.locator(".results button", { hasText: expect }).first().waitFor({ timeout: 10000 });
  await page.locator(".results button", { hasText: expect }).first().click();
}

async function openDirect(page, query) {
  await page.locator(".iconbtn[title='Новый чат']").click();
  await page.getByPlaceholder("Имя или @логин").fill(query);
  await page.waitForSelector(".results button", { timeout: 10000 });
  await page.locator(".results button").first().click();
  await page.waitForSelector(".composer textarea", { timeout: 10000 });
}

// Fake media devices so the call path is actually exercised: without them
// getUserMedia rejects and the client never gets as far as ringing, which
// would make the call checks below pass vacuously.
const browser = await chromium.launch({
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--allow-file-access-from-files",
  ],
});
const ru = {
  viewport: { width: 1440, height: 900 },
  locale: "ru-RU",
  permissions: ["microphone", "camera"],
};

const aliceCtx = await browser.newContext(ru);
const bobCtx = await browser.newContext(ru);
const carolCtx = await browser.newContext(ru);

const alice = await signUp(aliceCtx, "alice", "Алиса Иванова");
const bob = await signUp(bobCtx, "bob", "Борис Петров");
const carol = await signUp(carolCtx, "carol", "Карина Смирнова");

// ---------------------------------------------------------------- messaging

await openDirect(alice, "bob");
log("alice: direct chat open");

const secret = "Привет! Это сообщение сервер прочитать не может";
await alice.locator(".composer textarea").fill(secret);
await alice.keyboard.press("Enter");
await alice.waitForSelector(".msg--mine .msg__text", { timeout: 10000 });

await bob.waitForSelector(".row", { timeout: 15000 });
await bob.locator(".row").first().click();
await bob.waitForSelector(".msg__text", { timeout: 15000 });
check(
  (await bob.locator(".msg__text").last().innerText()).trim() === secret,
  "bob decrypted the first message",
);

// ---------------------------------------------------------------- emoji

await alice.locator(".iconbtn[title='Смайлы']").click();
await alice.waitForSelector(".emoji", { timeout: 5000 });
await alice.locator(".emoji__row button").first().click();
await alice.keyboard.press("Escape");
const composed = await alice.locator(".composer textarea").inputValue();
check(composed.length > 0, `emoji picker inserted "${composed}"`);
await alice.locator(".composer textarea").fill(`${composed} держи фото`);

// ------------------------------------------------------------ attachments

await alice.locator(String.raw`input[type="file"][accept="image/*,video/*"]`).setInputFiles(PHOTO);
await alice.waitForSelector(".chipFile", { timeout: 5000 });
await alice.keyboard.press("Enter");
await alice.waitForSelector(".msg--mine .att--media img.att__full", { timeout: 25000 });
log("alice: photo encrypted and sent");

await bob.waitForSelector(".att--media img.att__full", { timeout: 25000 });
const bobPhotoOk = await bob.locator(".att--media img.att__full").last().evaluate(
  (img) => img.naturalWidth > 100 && img.naturalHeight > 100,
);
check(bobPhotoOk, "bob downloaded and decrypted the photo");

// The bytes the server holds must not be the PNG we sent.
const storedIsCiphertext = await alice.evaluate(async () => {
  const token = localStorage.getItem("kivora.token");
  const auth = { Authorization: `Bearer ${token}` };
  const chans = await (await fetch("/api/v1/channels", { headers: auth })).json();
  const id = chans.channels.find((c) => c.kind === "dm").id;
  const hist = await (await fetch(`/api/v1/channels/${id}/messages`, { headers: auth })).json();
  const withFile = hist.messages.find((m) => (m.attachments ?? []).length > 0);
  if (!withFile) return { ok: false, why: "no attachment recorded" };
  const raw = await (await fetch(`/api/v1/uploads/${withFile.attachments[0]}`, { headers: auth })).arrayBuffer();
  const head = new Uint8Array(raw).slice(0, 8);
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  const bodies = hist.messages.map((m) => atob(m.body ?? ""));
  return { ok: !isPng && !bodies.some((b) => b.includes("фото") || b.includes("Привет")), why: "" };
});
check(storedIsCiphertext.ok, "the server stores ciphertext for both text and files");

// ---------------------------------------------------------------- pinning

await alice.locator(".msg--mine").first().hover();
await alice.locator(".msg--mine .msg__actions button[title='Закрепить']").first().click();
await alice.waitForSelector(".pinBar", { timeout: 8000 });
check(await alice.locator(".pinBar").isVisible(), "a pinned message shows in the pin bar");
await bob.waitForSelector(".pinBar", { timeout: 10000 });
check(await bob.locator(".pinBar").isVisible(), "the pin reached the other side");

// ------------------------------------------------------------ verification

await alice.locator(".chat__actions .pill").click();
await alice.waitForSelector(".safety--big", { timeout: 8000 });
const aliceNumber = (await alice.locator(".safety--big").innerText()).trim();
await bob.locator(".chat__actions .pill").click();
await bob.waitForSelector(".safety--big", { timeout: 8000 });
const bobNumber = (await bob.locator(".safety--big").innerText()).trim();
check(aliceNumber.length > 20 && aliceNumber === bobNumber, "both sides compute the same safety number");

await alice.screenshot({ path: `${SHOTS}/05-verify.png` });
await alice.getByRole("button", { name: "Ключи совпадают" }).click();
await alice.waitForTimeout(400);
check(
  await alice.locator(".verifyState--verified").first().isVisible(),
  "marking the keys verified sticks",
);
await alice.locator(".modal__head .iconbtn").click();
await bob.locator(".modal__head .iconbtn").click();

// ------------------------------------------------------- groups and threads

await alice.locator(".iconbtn[title='Новый чат']").click();
await alice.locator(".modal__box .tab", { hasText: /^Группа$/ }).click();
await alice.locator(".modal__box label:has-text('Название') input").fill("Проект");
// Wait for the *matching* row each time: the previous query's results stay on
// screen until the debounce fires, and clicking one of those would toggle the
// person off again.
await pick(alice, "bob", "Борис");
await pick(alice, "carol", "Карина");
check((await alice.locator(".chip").count()) === 2, "both people were added to the group");
await alice.getByRole("button", { name: "Создать" }).click();
await alice.waitForSelector(".chat__title h2:has-text('Проект')", { timeout: 15000 });
log("alice: group created");

await alice.locator(".chat__actions .btn--ghost").click(); // "О чате"
await alice.getByRole("button", { name: "Новая ветка" }).click();
await alice.waitForSelector(".modal__box");
await alice.locator(".modal__box label:has-text('Название ветки') input").fill("Только для двоих");
// Untick Carol so only Bob gets a key.
const carolPick = alice.locator(".pick", { hasText: "Карина" });
check((await carolPick.count()) === 1, `the thread picker lists the group members (${await alice.locator(".pick").count()} shown)`);
await carolPick.first().click();
check((await alice.locator(".pick--on").count()) === 1, "unticking a member leaves only the chosen one selected");
await alice.getByRole("button", { name: "Создать ветку" }).click();
await alice.waitForSelector(".chat__title h2:has-text('Только для двоих')", { timeout: 15000 });
await alice.locator(".composer textarea").fill("Секрет только для нас двоих");
await alice.keyboard.press("Enter");
await alice.waitForSelector(".msg--mine .msg__text", { timeout: 10000 });
log("alice: thread created with a narrower audience");

// Carol is in the group but must not hold the thread's key.
await carol.reload({ waitUntil: "networkidle" });
await carol.waitForSelector(".auth__hint", { timeout: 20000 });
await carol.locator('input[type="password"]').fill("correct horse battery staple");
await carol.getByRole("button", { name: "Разблокировать" }).click();
await carol.waitForSelector(".shell", { timeout: 40000 });
const carolSeesThread = await carol.evaluate(async () => {
  const token = localStorage.getItem("kivora.token");
  const auth = { Authorization: `Bearer ${token}` };
  const chans = await (await fetch("/api/v1/channels", { headers: auth })).json();
  const group = chans.channels.find((c) => c.kind === "group");
  if (!group) return "no group";
  const res = await (await fetch(`/api/v1/channels/${group.id}/threads`, { headers: auth })).json();
  return res.threads.length;
});
check(carolSeesThread === 0, `a group member outside the thread cannot list it (saw ${carolSeesThread})`);

// ------------------------------------------------------------- chat menu

await alice.locator(".rail__btn").first().click();
await alice.locator(".rowWrap").filter({ hasText: "Борис" }).first().hover();
await alice.locator(".rowWrap").filter({ hasText: "Борис" }).first().locator(".rowWrap__more").click();
await alice.waitForSelector(".menu", { timeout: 5000 });
await alice.screenshot({ path: `${SHOTS}/06-chatmenu.png` });
await alice.getByRole("menuitem", { name: "В архив" }).click();
await alice.waitForTimeout(900);
check(
  await alice.locator(".rail__btn[title='Архив']").isVisible(),
  "archiving a chat reveals the archive section",
);
await alice.locator(".rail__btn[title='Архив']").click();
await alice.waitForSelector(".row", { timeout: 8000 });
check((await alice.locator(".row").count()) >= 1, "the archived chat is in the archive");

// Put it back so the later screenshots look normal.
await alice.locator(".rowWrap").first().hover();
await alice.locator(".rowWrap").first().locator(".rowWrap__more").click();
await alice.getByRole("menuitem", { name: "Вернуть из архива" }).click();
await alice.waitForTimeout(700);

// ------------------------------------------------------------------ calls
//
// Media itself needs a camera and a microphone, which this headless browser
// does not have. What *is* testable without them is the part that was broken:
// declining used to be a local dismissal, so the caller rang forever. Here bob
// declines and alice's call has to end on its own.

// Un-archiving left the sidebar on the (now empty) archive rail.
await alice.locator(".rail__btn").first().click();
await alice.locator(".rowWrap").filter({ hasText: "Борис" }).first().waitFor({ timeout: 10000 });
await alice.locator(".rowWrap").filter({ hasText: "Борис" }).first().click();
await alice.waitForSelector(".composer textarea", { timeout: 10000 });
await alice.locator(".chat__actions button[title='Аудиозвонок']").click();
await bob.waitForSelector(".ringing", { timeout: 10000 });
check(true, "the ring reaches the other side");

// Before declining: answer once, and check that both ends derive the same
// short authentication string from the DTLS fingerprints actually in use. A
// server that swapped a fingerprint would terminate two legs and these would
// differ — which is the only thing that distinguishes it from a real call.
await bob.getByRole("button", { name: "Принять" }).click();
await alice.locator(".call__sas strong").waitFor({ timeout: 25000 });
await bob.locator(".call__sas strong").waitFor({ timeout: 25000 });
await alice.waitForTimeout(1200);
const sasAlice = (await alice.locator(".call__sas strong").innerText()).trim();
const sasBob = (await bob.locator(".call__sas strong").innerText()).trim();
check(/^\d{4} \d{4} \d{4} \d{4}$/.test(sasAlice), `the call shows a code (${sasAlice})`);
check(sasAlice === sasBob, "and both ends derive the same one");
await alice.screenshot({ path: `${SHOTS}/12-call.png` });
await alice.getByRole("button", { name: "Завершить" }).click();

// The other side must not be left alone in a live call with the microphone on.
await bob.locator(".call").waitFor({ state: "detached", timeout: 15000 });
check(true, "hanging up ends the call for the other person too");
await alice.waitForTimeout(600);

// Now the decline path, from a fresh ring.
await alice.locator(".chat__actions button[title='Аудиозвонок']").click();
await bob.waitForSelector(".ringing", { timeout: 15000 });
await bob.getByRole("button", { name: "Отклонить" }).click();
await bob.waitForTimeout(300);
check((await bob.locator(".ringing").count()) === 0, "declining clears the banner");

// The caller must be told, not left ringing. The overlay says why, then goes.
await alice
  .locator(".call")
  .filter({ hasText: "Звонок отклонён" })
  .first()
  .waitFor({ timeout: 8000 })
  .then(() => check(true, "the caller is told the call was declined"))
  .catch(() => check(false, "the caller is told the call was declined"));
await alice.locator(".call").waitFor({ state: "detached", timeout: 10000 });
check(true, "the declined call tears itself down");

// ------------------------------------------------------------ admin panel

await alice.locator(".rail__btn[title='Администрирование']").click();
await alice.waitForSelector(".adm__body", { timeout: 15000 });
check(
  new URL(alice.url()).pathname === "/admin",
  `the console has its own address (${new URL(alice.url()).pathname})`,
);
check(
  (await alice.locator(".rail").count()) === 0,
  "and its own chrome — no messenger rail over a server dashboard",
);
await alice.waitForSelector(".statRow", { timeout: 15000 });
const userCount = await alice.locator(".stat").first().locator("strong").innerText();
check(Number(userCount) === 3, `the admin overview counts the users (${userCount})`);
check(await alice.locator(".miniChart svg").first().isVisible(), "the activity chart rendered");
await alice.waitForTimeout(500);
await alice.screenshot({ path: `${SHOTS}/07-admin.png` });

await alice.locator(".adm__nav button", { hasText: "Пользователи" }).click();
await alice.waitForSelector(".dataTable tbody tr", { timeout: 8000 });
check(new URL(alice.url()).pathname === "/admin/users", "each page has its own address");
check((await alice.locator(".dataTable tbody tr").count()) === 3, "the user table lists everyone");
await alice.screenshot({ path: `${SHOTS}/08-admin-users.png` });

// The search box in the bar has to narrow the table, not just sit there.
await alice.locator(".adm__search input").fill("bob");
await alice.waitForTimeout(300);
check(
  (await alice.locator(".dataTable tbody tr").count()) === 1,
  "the console search narrows the table",
);
await alice.locator(".adm__search input").fill("");

// The diagnostics page: an operator can look at the error page on purpose.
await alice.locator(".adm__nav button", { hasText: "Страницы" }).click();
await alice.waitForSelector(".pagesList", { timeout: 8000 });
check((await alice.locator(".pagesList li").count()) === 3, "the pages tab lists what to check");
await alice.locator(".pagesList .btn", { hasText: "Открыть" }).first().getAttribute("href");
await alice.screenshot({ path: `${SHOTS}/11-admin-pages.png` });

// The server must answer 200 for a real console page and 404 for a dead link:
// a blanket 404 marks the console missing, a blanket 200 hides broken links.
const codes = await alice.evaluate(async () => ({
  admin: (await fetch("/admin", { method: "GET" })).status,
  dead: (await fetch("/definitely-not-a-page", { method: "GET" })).status,
}));
check(codes.admin === 200, `the console answers 200 (${codes.admin})`);
check(codes.dead === 404, `a dead link answers 404 (${codes.dead})`);

// A normal user must not reach it at all.
const bobAdmin = await bob.evaluate(async () => {
  const token = localStorage.getItem("kivora.token");
  const res = await fetch("/api/v1/admin/overview", { headers: { Authorization: `Bearer ${token}` } });
  return res.status;
});
check(bobAdmin === 403, "a normal account is refused by the admin API");
check(
  (await bob.locator(".rail__btn[title='Администрирование']").count()) === 0,
  "and never sees the admin button",
);

// --------------------------------------------------------- logo goes home

// The console has no chat rail, so getting back to the messenger is its own
// step — which is the separation working, not an obstacle.
await alice.locator(".adm__nav button", { hasText: "Вернуться в мессенджер" }).click();
await alice.waitForSelector(".rail__brand", { timeout: 15000 });
check(new URL(alice.url()).pathname === "/", "leaving the console returns to the app address");

await alice.locator(".rail__brand").click();
await alice.waitForSelector(".sidebar", { timeout: 8000 });
check(await alice.locator(".sidebar").isVisible(), "the logo returns to the chat list");

// ------------------------------------------------------------------- 404

const notFound = await alice.goto(`${BASE}/no-such-page`, { waitUntil: "networkidle" });
check(notFound?.status() === 404, `an unknown path answers 404 (${notFound?.status()})`);
await alice.waitForSelector(".g404", { timeout: 15000 });
await alice.waitForTimeout(500);
await alice.screenshot({ path: `${SHOTS}/09-404.png` });
await alice.getByRole("button", { name: "Вернуться к чатам" }).click();
// A hard navigation dropped the in-memory keys, so leaving the 404 lands on
// the unlock screen — which is the correct behaviour, not a failure.
await alice.waitForSelector(".auth__panel, .sidebar", { timeout: 10000 });
check(new URL(alice.url()).pathname === "/", "leaving the 404 screen cleans up the address bar");

if (await alice.locator(".auth__hint").count()) {
  await alice.locator('input[type="password"]').fill("correct horse battery staple");
  await alice.getByRole("button", { name: "Разблокировать" }).click();
  await alice.waitForSelector(".shell", { timeout: 40000 });
  check(true, "the vault unlocks again after a full page load");
}

// The standalone page a reverse proxy can serve is there too, and it has to
// stand alone: no script, no external stylesheet, no image file. A page that
// needs the app is useless exactly when the app is what is broken.
const standalone = await alice.request.get(`${BASE}/404.html`);
check(standalone.ok(), "the standalone 404 page is published for reverse proxies");
const standaloneHtml = await standalone.text();
check(
  !/<script/i.test(standaloneHtml) && !/<link[^>]+stylesheet/i.test(standaloneHtml),
  "and it depends on nothing it would have to fetch",
);

// The deliberate preview: checking the error page should not require inventing
// a broken link and then remembering it was deliberate.
const preview = await alice.goto(`${BASE}/404`, { waitUntil: "networkidle" });
await alice.waitForSelector(".g404__art", { timeout: 10000 });
check(preview !== null, "the 404 page can be previewed on purpose at /404");

// ----------------------------------------------------------- screenshots

// Back out of the preview, and unlock again: /404 was a hard navigation.
await alice.goto(BASE, { waitUntil: "networkidle" });
await alice.waitForSelector(".auth__panel, .shell", { timeout: 15000 });
if (await alice.locator(".auth__hint").count()) {
  await alice.locator('input[type="password"]').fill("correct horse battery staple");
  await alice.getByRole("button", { name: "Разблокировать" }).click();
}
await alice.waitForSelector(".shell", { timeout: 40000 });

await alice.locator(".rail__btn").first().click();
await alice.locator(".row").filter({ hasText: "Борис" }).first().click();
await alice.waitForTimeout(900);
await alice.screenshot({ path: `${SHOTS}/01-chat-dark.png` });

await alice.locator(".rail__me").click();
await alice.waitForSelector(".settings", { timeout: 8000 });
await alice.waitForTimeout(400);
await alice.screenshot({ path: `${SHOTS}/03-settings.png` });

// Light theme, and back to the conversation.
await alice.getByRole("button", { name: /тема/i }).click();
await alice.waitForTimeout(300);
await alice.locator(".rail__btn").first().click();
await alice.locator(".row").filter({ hasText: "Борис" }).first().click();
await alice.waitForTimeout(700);
await alice.screenshot({ path: `${SHOTS}/02-chat-light.png` });

// ------------------------------------------------------------- language

const enCtx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: "en-US" });
const enPage = await enCtx.newPage();
await enPage.goto(BASE, { waitUntil: "networkidle" });
await enPage.waitForSelector(".auth__panel", { timeout: 20000 });
const enText = await enPage.locator(".auth__panel").innerText();
check(enText.includes("Sign in") || enText.includes("Sign up"), "an English browser gets the English UI");
await enPage.screenshot({ path: `${SHOTS}/04-login-en.png` });

const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: "ru-RU" });
const phonePage = await phone.newPage();
await phonePage.goto(BASE, { waitUntil: "networkidle" });
await phonePage.waitForSelector(".auth__panel", { timeout: 20000 });
await phonePage.screenshot({ path: `${SHOTS}/10-mobile.png` });

await browser.close();

console.log("");
if (failures.length > 0) {
  console.error(`FAILED (${failures.length}):`);
  for (const f of failures) console.error(" -", f);
  process.exit(1);
}
console.log("ALL END-TO-END CHECKS PASSED");
