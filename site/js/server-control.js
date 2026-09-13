// The control part of server.html, only shown to viewers with the control key:
// moderation buttons on a player's page, and the console with the action log.
//
// Actions go up the page's WebSocket; the Worker checks them and passes them to
// the server, and every result comes back as a log entry. The page re-renders on
// every push, so the text fields are made once and moved into each new render,
// which keeps what you were typing.
import { panel } from "./cards.js";
import { el, timeAgo, titleCase } from "./util.js";

const CONFIRM_MS = 4000;
const fields = {
  command: el("input", { type: "text", class: "console-input", placeholder: "Run a command, e.g. time set day", autocomplete: "off", spellcheck: "false", "aria-label": "Command", maxlength: "1000" }),
  reason: el("input", { type: "text", class: "control-input", placeholder: "Reason (optional)", maxlength: "200", "aria-label": "Reason for kick or ban" }),
  message: el("input", { type: "text", class: "control-input", placeholder: "Message to this player", maxlength: "256", "aria-label": "Message" }),
};
let fieldsFor = null;       // the player the reason and message fields belong to
const commandHistory = [];         // commands run from this tab, for arrow up/down
let historyAt = 0;

let send = () => null;
export function setSender(fn) { send = fn; }

// A destructive button asks once more: the first click arms it, a second within 4 s runs it.
function confirmButton(label, armed, run, className = "btn btn-stone btn-small") {
  const button = el("button", { type: "button", class: className, text: label });
  let timer = null;
  button.addEventListener("click", () => {
    if (!button.dataset.armed) {
      button.dataset.armed = "true";
      button.textContent = armed;
      timer = setTimeout(() => { delete button.dataset.armed; button.textContent = label; }, CONFIRM_MS);
      return;
    }
    clearTimeout(timer);
    run();
  });
  return button;
}

function actionButton(label, run) {
  const button = el("button", { type: "button", class: "btn btn-stone btn-small", text: label });
  button.addEventListener("click", run);
  return button;
}

const STATUS_TEXT = { sent: "Sent", done: "Done", failed: "Failed" };
const ACTION_TEXT = {
  kick: (who) => `Kick ${who}`,
  ban: (who) => `Ban ${who}`,
  pardon: (who) => `Unban ${who}`,
  whitelist_add: (who) => `Add ${who} to the whitelist`,
  whitelist_remove: (who) => `Remove ${who} from the whitelist`,
  gamemode: (who, mode) => `Set ${who} to ${titleCase(mode || "")}`,
  heal: (who) => `Heal ${who}`,
  feed: (who) => `Feed ${who}`,
  message: (who) => `Message ${who}`,
};

function logRow(entry) {
  const who = entry.target || "a player";
  const label = ACTION_TEXT[entry.action] ? ACTION_TEXT[entry.action](who, entry.detail) : `${titleCase(entry.action || "")} ${who}`;
  const detail = ["kick", "ban", "message"].includes(entry.action) && entry.detail ? ` · ${entry.detail}` : "";
  const what = entry.action === "command"
    ? el("code", { text: `/${entry.detail}` })
    : el("span", { text: label + detail });
  return el("li", { class: "log-row", "data-status": entry.status || "sent" }, [
    el("div", { class: "log-head" }, [
      el("span", { class: "log-status", text: STATUS_TEXT[entry.status] || "Sent" }),
      what,
      el("time", { text: entry.at ? timeAgo(entry.at) : "" }),
    ]),
    entry.output ? el("div", { class: "log-output", text: entry.output }) : null,
  ]);
}

/** Buttons for one player. `player` is the pushed row; `log` the action log. */
export function controlsPanel(player, { connected, log }) {
  if (fieldsFor !== player.uuid) {
    fieldsFor = player.uuid;
    fields.reason.value = "";
    fields.message.value = "";
  }
  const act = (action, extra = {}) => send({ action, uuid: player.uuid, ...extra });
  const reason = () => fields.reason.value.trim();
  const online = Boolean(player.online);

  const modeSelect = el("select", { class: "control-select", "aria-label": "Game mode" },
    ["survival", "creative", "adventure", "spectator"].map((mode) => {
      const option = el("option", { value: mode, text: titleCase(mode) });
      if (player.game_mode === mode) option.selected = true;
      return option;
    }));
  modeSelect.addEventListener("change", () => act("gamemode", { mode: modeSelect.value }));

  const sendMessage = el("button", { type: "button", class: "btn btn-green btn-small", text: "Send" });
  const submitMessage = () => {
    const text = fields.message.value.trim();
    if (!text) return;
    act("message", { text });
    fields.message.value = "";
  };
  sendMessage.addEventListener("click", submitMessage);
  fields.message.onkeydown = (event) => { if (event.key === "Enter") submitMessage(); };

  const groups = [];
  if (online) {
    groups.push(el("div", { class: "control-row" }, [
      actionButton("Heal", () => act("heal")),
      actionButton("Feed", () => act("feed")),
      el("label", { class: "control-label" }, ["Game mode", modeSelect]),
    ]));
    groups.push(el("div", { class: "control-row" }, [fields.message, sendMessage]));
  }
  groups.push(el("div", { class: "control-row" }, [
    fields.reason,
    online ? confirmButton("Kick", "Click again to kick", () => act("kick", { reason: reason() })) : null,
    player.banned
      ? actionButton("Unban", () => act("pardon"))
      : confirmButton("Ban", "Click again to ban", () => act("ban", { reason: reason() }), "btn btn-danger btn-small"),
  ]));
  groups.push(el("div", { class: "control-row" }, [
    player.whitelisted
      ? actionButton("Remove from whitelist", () => act("whitelist_remove"))
      : actionButton("Add to whitelist", () => act("whitelist_add")),
    el("span", { class: "control-flags", text: [player.op ? "Operator" : null, player.banned ? "Banned" : null, player.whitelisted ? "Whitelisted" : null].filter(Boolean).join(" · ") }),
  ]));

  const mine = log.filter((entry) => entry.target === player.name).slice(-3).reverse();
  const body = connected
    ? el("fieldset", { class: "controls" }, groups)
    : el("p", { class: "empty", text: "The server isn't connected right now, so actions are unavailable." });
  return panel("Actions", [body, mine.length ? el("ul", { class: "log-list" }, mine.map(logRow)) : null], "controls-panel", "control key");
}

/** The console and the full action log, for the overview. */
export function consolePanel({ connected, log }) {
  const run = el("button", { type: "button", class: "btn btn-green btn-small", text: "Run" });
  const submit = () => {
    const command = fields.command.value.trim().replace(/^\/+/, "");
    if (!command) return;
    send({ action: "command", command });
    if (commandHistory.at(-1) !== command) commandHistory.push(command);
    historyAt = commandHistory.length;
    fields.command.value = "";
  };
  run.addEventListener("click", submit);
  fields.command.onkeydown = (event) => {
    if (event.key === "Enter") submit();
    else if (event.key === "ArrowUp" && historyAt > 0) {
      historyAt -= 1;
      fields.command.value = commandHistory[historyAt];
      event.preventDefault();
    } else if (event.key === "ArrowDown" && historyAt < commandHistory.length) {
      historyAt += 1;
      fields.command.value = commandHistory[historyAt] || "";
      event.preventDefault();
    }
  };
  fields.command.disabled = !connected;
  run.disabled = !connected;

  const entries = log.slice().reverse();
  return panel("Console", [
    el("div", { class: "console-row" }, [el("span", { class: "console-prompt", text: "/" }), fields.command, run]),
    connected ? null : el("p", { class: "empty", text: "The server isn't connected right now." }),
    entries.length
      ? el("ul", { class: "log-list log-scroll" }, entries.map(logRow))
      : el("p", { class: "empty", text: "Actions and commands from this page show up here, with what the server said." }),
  ], "console-panel", connected ? "server connected" : "server offline");
}
