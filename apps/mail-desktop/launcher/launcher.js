const byId = (id) => document.getElementById(id);
const form = byId("connect");
const status = byId("status");
let accounts = [];
let busy = false;

function showSaved(show) {
  byId("saved").hidden = !show;
  byId("add-mailbox").hidden = show;
  byId("back").hidden = accounts.length === 0;
  status.textContent = "";
  if (!show) byId("email").focus();
}
function setStatus(message, error = false) {
  status.classList.toggle("error", error);
  status.textContent = message;
}
function renderAccounts() {
  const rows = accounts.map((account) => {
    const row = document.createElement("li");
    const open = document.createElement("button");
    open.className = "account";
    open.textContent = account.email;
    const server = document.createElement("small");
    server.textContent = account.mode === "cloud" ? "OpenShip Cloud" : new URL(account.origin).host;
    open.append(server);
    open.onclick = () => run("Opening mailbox…", () => window.mailboxes.open(account.id));
    const forget = document.createElement("button");
    forget.className = "remove";
    forget.textContent = "Remove";
    forget.setAttribute("aria-label", "Remove " + account.email);
    forget.onclick = () => run("", () => window.mailboxes.forget(account.id));
    row.append(open, forget);
    return row;
  });
  byId("accounts").replaceChildren(...rows);
}
async function refresh() {
  const result = await window.mailboxes.list();
  if (result.error) throw new Error(result.error);
  accounts = result.data.accounts;
  renderAccounts();
  history.replaceState(null, "");
  showSaved(accounts.length > 0);
  if (result.data.resume)
    await run("Opening mailbox…", () => window.mailboxes.open(accounts[0].id));
}
async function run(message, operation) {
  if (busy) return;
  busy = true;
  const controls = [...document.querySelectorAll("main button, main input")];
  controls.forEach((control) => (control.disabled = true));
  setStatus(message);
  try {
    const result = await operation();
    if (result.error) throw new Error(result.error);
    await refresh();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    busy = false;
    controls.forEach((control) => (control.disabled = false));
  }
}
form.onchange = () => {
  const selfHosted = form.elements.mode.value === "self";
  byId("server").hidden = !selfHosted;
  byId("url").required = selfHosted;
};
form.onsubmit = (event) => {
  event.preventDefault();
  const input = {
    email: byId("email").value,
    mode: form.elements.mode.value,
    url: byId("url").value,
  };
  void run(input.mode === "cloud" ? "Finding your mailbox…" : "Opening webmail…", () =>
    window.mailboxes.connect(input),
  );
};
byId("add").onclick = () => {
  history.pushState({ add: true }, "");
  form.reset();
  form.onchange();
  showSaved(false);
};
byId("back").onclick = () => history.back();
window.addEventListener("popstate", () => showSaved(accounts.length > 0 && !history.state?.add));
refresh().catch((error) => setStatus(error.message, true));
