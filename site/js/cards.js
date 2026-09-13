// The dashboard cards. Each takes plain data and returns a DOM node.
import { biomeName, entityName, itemName, itemUrl, spriteUrl } from "./assets.js";
import {
  clockTime, count, distance, duration, el, gib, plainNumber, shortId, timeAgo, titleCase,
} from "./util.js";

// ---- building blocks -------------------------------------------------------------

export function statRows(pairs) {
  const list = el("dl");
  for (const [label, value] of pairs) {
    if (value === null || value === undefined || value === "") continue;
    list.append(el("div", { class: "row" }, [el("dt", { text: label }), el("dd", { text: String(value) })]));
  }
  return list;
}

export function panel(title, children, extraClass = "", note = "") {
  const head = note
    ? el("div", { class: "panel-head" }, [el("h2", { text: title }), el("small", { text: note })])
    : el("h2", { text: title });
  return el("section", { class: `panel ${extraClass}`.trim() }, [head, ...children]);
}

export function chip(label, value) {
  const node = el("span", { class: "chip" });
  if (label) node.append(label, " ");
  node.append(el("b", { text: value }));
  return node;
}

export function itemIcon(id, className = "big-icon") {
  return el("img", { class: className, src: itemUrl(id), alt: "" });
}

function tile(icon, label, value, sub) {
  const img = itemIcon(icon, "");
  img.addEventListener("error", () => { img.src = itemUrl("barrier"); }, { once: true });
  return el("div", { class: "tile" }, [
    img,
    el("div", {}, [
      el("span", { class: "k", text: label }),
      el("span", { class: "v", text: String(value) }),
      sub ? el("span", { class: "s", text: sub }) : null,
    ]),
  ]);
}

function bar(fraction, { thin = false, heat = false } = {}) {
  const pct = Math.max(0, Math.min(1, fraction || 0)) * 100;
  const node = el("div", { class: `bar${thin ? " bar-thin" : ""}`, role: "presentation" });
  if (heat) node.dataset.level = pct >= 85 ? "hot" : pct >= 65 ? "warm" : "ok";
  const level = el("i");
  level.style.width = `${pct}%`;
  node.append(level);
  return node;
}

function meter(label, valueText, fraction, note) {
  return el("div", { class: "meter" }, [
    el("div", { class: "meter-head" }, [el("span", { text: label }), el("b", { text: valueText })]),
    bar(fraction, { heat: true }),
    note ? el("span", { class: "meter-note", text: note }) : null,
  ]);
}

// ---- cards -------------------------------------------------------------------------

export function worldPanel(world) {
  const t = world.time ?? 0;
  const night = t >= 13000 && t < 23000;
  const weather = { clear: ["sunflower", "Clear"], rain: ["water_bucket", "Rain"], thunder: ["lightning_rod", "Thunderstorm"] }[world.weather]
    || ["sunflower", titleCase(world.weather || "clear")];
  const mode = { survival: "iron_sword", creative: "grass_block", adventure: "map", spectator: "ender_eye" }[world.game_mode] || "iron_sword";
  return panel("World", [
    el("div", { class: "tiles tiles-2" }, [
      tile("clock", `Day ${count(world.day ?? 0)}`, clockTime(t), night ? "Night" : "Day"),
      tile(weather[0], "Weather", weather[1]),
      world.biome ? tile("filled_map", "Biome", biomeName(world.biome)) : null,
      tile(world.hardcore ? "wither_rose" : "totem_of_undying", "Difficulty", world.hardcore ? "Hardcore" : titleCase(world.difficulty || "normal")),
      world.game_mode ? tile(mode, "Game mode", titleCase(world.game_mode)) : null,
    ]),
  ], "", world.name || "");
}

export function machinePanel(system, game, online) {
  const meters = [];
  if (typeof system.cpu_percent === "number") {
    meters.push(meter("CPU", `${Math.round(system.cpu_percent)}%`, system.cpu_percent / 100,
      [system.cpu, system.cpu_cores ? `${system.cpu_cores} threads` : null].filter(Boolean).join(" · ")));
  }
  if (typeof system.gpu_percent === "number") {
    meters.push(meter("GPU", `${Math.round(system.gpu_percent)}%`, system.gpu_percent / 100, system.gpu));
  }
  if (system.mem_used && system.mem_total) {
    meters.push(meter("Memory", `${gib(system.mem_used)} / ${gib(system.mem_total)}`, system.mem_used / system.mem_total));
  }
  if (system.vram_used && system.vram_total) {
    meters.push(meter("Video memory", `${gib(system.vram_used)} / ${gib(system.vram_total)}`, system.vram_used / system.vram_total));
  }
  const rows = [
    ["FPS", online && game?.fps ? String(game.fps) : null],
    ["Tick time", online && typeof game?.mspt === "number" ? `${game.mspt} ms` : null],
    ["Game memory", online && game?.mem_max_mb ? `${plainNumber(game.mem_used_mb)} / ${plainNumber(game.mem_max_mb)} MB` : null],
    ["CPU temp", system.cpu_temp ? `${Math.round(system.cpu_temp)} °C` : null],
    ["GPU temp", system.gpu_temp ? `${Math.round(system.gpu_temp)} °C` : null],
    ["OS", system.os],
    ["Up for", system.uptime_seconds ? duration(system.uptime_seconds) : null],
  ];
  // without live numbers, still name the hardware
  if (!meters.length) rows.unshift(["CPU", system.cpu], ["GPU", system.gpu]);
  const list = statRows(rows);
  if (meters.length) list.classList.add("machine-rows");
  return panel("The machine", [...meters, list]);
}

const ADV_TABS = {
  story: ["grass_block", "Minecraft"], nether: ["red_nether_bricks", "Nether"], end: ["end_stone", "The End"],
  adventure: ["map", "Adventure"], husbandry: ["hay_block", "Husbandry"],
};
const tabOrder = (name) => {
  const index = Object.keys(ADV_TABS).indexOf(name);
  return index < 0 ? 99 : index;
};

function advancementRow(adv, { progress = null, after = null } = {}) {
  const type = ["task", "goal", "challenge"].includes(adv.type) ? adv.type : "task";
  const title = el("span", { class: "adv-title", text: adv.title });
  title.dataset.type = type;
  return el("div", { class: "adv", title: adv.description || "" }, [
    el("div", { class: "adv-frame" }, [
      el("img", { class: "frame", alt: "", src: spriteUrl(`${type}_frame${progress === null ? "" : "_open"}`) }),
      el("img", { class: "icon", alt: "", src: itemUrl(adv.icon) }),
    ]),
    el("div", { class: "adv-body" }, [
      title,
      el("span", { class: "adv-desc", text: adv.description || "" }),
      progress === null ? null : bar(progress, { thin: true }),
    ]),
    after ? el("span", { class: "adv-when", text: after }) : null,
  ]);
}

export function advancementsPanel(adv) {
  const tabs = Object.entries(adv.tabs || {}).sort(([a], [b]) => tabOrder(a) - tabOrder(b));
  return panel("Advancements", [
    el("div", { class: "adv-total" }, [
      el("strong", { text: `${adv.done} / ${adv.total}` }),
      el("span", { text: `${adv.total ? Math.floor((adv.done / adv.total) * 100) : 0}% done` }),
    ]),
    bar(adv.total ? adv.done / adv.total : 0),
    tabs.length ? el("div", { class: "adv-tabs" }, tabs.map(([name, [done, total]]) => {
      const [icon, label] = ADV_TABS[name] || ["book", titleCase(name)];
      return el("div", { class: "adv-tab" }, [
        itemIcon(icon, ""), el("span", { text: label }), bar(total ? done / total : 0, { thin: true }), el("b", { text: `${done}/${total}` }),
      ]);
    })) : null,
    adv.recent?.length ? el("h3", { class: "subhead", text: "Recently earned" }) : null,
    adv.recent?.length ? el("div", { class: "adv-list" }, adv.recent.map((item) =>
      advancementRow(item, { after: item.at ? timeAgo(item.at) : null }))) : null,
    adv.in_progress?.length ? el("h3", { class: "subhead", text: "Almost there" }) : null,
    adv.in_progress?.length ? el("div", { class: "adv-list" }, adv.in_progress.map((item) =>
      advancementRow(item, { progress: item.percent, after: item.progress || null }))) : null,
  ]);
}

export function statsPanel(stats, online) {
  const mobIcon = (id) => `${shortId(id)}_spawn_egg`;
  const hearts = (value) => `${count(Math.round((value ?? 0) / 20))} ♥`;
  const tiles = [
    tile("clock", "Play time", duration((stats.play_time ?? 0) / 20)),
    tile("bone", "Deaths", count(stats.deaths), stats.deaths ? `last ${duration((stats.time_since_death ?? 0) / 20)} ago` : "never died"),
    tile("iron_sword", "Mobs killed", count(stats.mob_kills)),
    tile("diamond_pickaxe", "Blocks mined", count(stats.blocks_mined)),
    tile("leather_boots", "Travelled", distance(stats.travel_cm), stats.flown_cm ? `${distance(stats.flown_cm)} by elytra` : null),
    tile("crafting_table", "Items crafted", count(stats.items_crafted)),
    tile("golden_sword", "Damage dealt", hearts(stats.damage_dealt)),
    tile("iron_chestplate", "Damage taken", hearts(stats.damage_taken)),
    tile("rabbit_foot", "Jumps", count(stats.jumps)),
    stats.fish_caught ? tile("cod", "Fish caught", count(stats.fish_caught)) : null,
    stats.animals_bred ? tile("wheat", "Animals bred", count(stats.animals_bred)) : null,
    stats.traded ? tile("emerald", "Villager trades", count(stats.traded)) : null,
    stats.enchanted ? tile("enchanting_table", "Items enchanted", count(stats.enchanted)) : null,
    stats.slept ? tile("red_bed", "Nights slept", count(stats.slept)) : null,
    stats.raids_won ? tile("ominous_bottle", "Raids won", count(stats.raids_won)) : null,
  ];
  const favourites = [
    stats.top_mined && tile(shortId(stats.top_mined.id), "Mined the most", itemName(stats.top_mined), `${count(stats.top_mined.count)} blocks`),
    stats.top_crafted && tile(shortId(stats.top_crafted.id), "Crafted the most", itemName(stats.top_crafted), `${count(stats.top_crafted.count)} made`),
    stats.top_killed && tile(mobIcon(stats.top_killed.id), "Hunted the most", entityName(stats.top_killed.id), `${count(stats.top_killed.count)} killed`),
    stats.top_killed_by && tile(mobIcon(stats.top_killed_by.id), "Nemesis", entityName(stats.top_killed_by.id), `killed you ${count(stats.top_killed_by.count)}×`),
  ].filter(Boolean);
  return panel("Statistics", [
    el("div", { class: "tiles" }, tiles),
    favourites.length ? el("h3", { class: "subhead", text: "Favourites" }) : null,
    favourites.length ? el("div", { class: "tiles" }, favourites) : null,
  ], "stats-panel", online ? "" : "as of the last session");
}

export function playtimePanel(days) {
  const most = Math.max(...days.map((day) => day.seconds), 1);
  const total = days.reduce((sum, day) => sum + day.seconds, 0);
  const short = (s) => (s < 60 ? "" : s < 3600 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(s < 36000 ? 1 : 0)}h`);
  const chart = el("div", { class: "pt-chart", role: "img" }, days.map((day, index) => {
    const today = index === days.length - 1;
    const weekday = new Date(`${day.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" });
    const level = el("i");
    level.style.height = `${day.seconds ? Math.max(4, (day.seconds / most) * 100) : 0}%`;
    const column = el("div", { class: "pt-day", title: `${day.date}: ${duration(day.seconds)}` }, [
      el("span", { class: "pt-value", text: short(day.seconds) }),
      el("div", { class: "pt-track" }, [level]),
      el("span", { class: "pt-label", text: today ? "Today" : weekday }),
    ]);
    if (today) column.dataset.today = "true";
    return column;
  }));
  chart.setAttribute("aria-label", days.map((day) => `${day.date}: ${duration(day.seconds)}`).join(", "));
  return panel("Play time", [chart], "", `${duration(total)} this week`);
}

export function mapPanel(info, playerName) {
  return panel("World map", [
    el("p", { text: info.center
      ? `A 3D map of the area around ${playerName ? `${playerName}'s` : "the"} last logout, rendered ${timeAgo(info.rendered_at)}.`
      : `A 3D map of the world, rendered ${timeAgo(info.rendered_at)}.` }),
    el("a", { class: "btn btn-green", href: "map/", text: "Open world map" }),
  ], "map-card");
}

const CURSE_UNITS = { cpu_temp: " °C", gpu_temp: " °C", cpu_percent: "%", gpu_percent: "%", mem_percent: "%", uptime_hours: " h" };

export function cursesPanel(curses) {
  return panel("Recent curses", [statRows(curses.map((curse) => [
    curse.name,
    `${CURSE_UNITS[curse.metric] ? Math.round(curse.value) + CURSE_UNITS[curse.metric] : curse.value} · ${timeAgo(curse.at)}`,
  ]))]);
}
