package mcstatus;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import net.minecraft.advancements.AdvancementHolder;
import net.minecraft.advancements.AdvancementProgress;
import net.minecraft.advancements.CriterionProgress;
import net.minecraft.advancements.DisplayInfo;
import net.minecraft.client.Minecraft;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.stats.ServerStatsCounter;
import net.minecraft.stats.Stat;
import net.minecraft.stats.StatType;
import net.minecraft.stats.Stats;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;

/**
 * Statistics and advancements, read from the integrated server — so singleplayer
 * only. The client never has these for servers without asking, and servers
 * aren't ours to report on anyway.
 *
 * <p>Collected on the server thread every few seconds and handed to
 * {@link StateWriter} as a finished object, so nothing here races the game.
 */
final class Progress {
	private static final long INTERVAL_MS = 10_000;
	private static final int RECENT = 6;
	private static final int IN_PROGRESS = 4;

	/** Distance stats that are travel, in cm. Falling isn't. */
	private static final Identifier[] TRAVEL = {
		Stats.WALK_ONE_CM, Stats.CROUCH_ONE_CM, Stats.SPRINT_ONE_CM, Stats.WALK_ON_WATER_ONE_CM,
		Stats.CLIMB_ONE_CM, Stats.FLY_ONE_CM, Stats.WALK_UNDER_WATER_ONE_CM, Stats.MINECART_ONE_CM,
		Stats.BOAT_ONE_CM, Stats.PIG_ONE_CM, Stats.HAPPY_GHAST_ONE_CM, Stats.HORSE_ONE_CM,
		Stats.AVIATE_ONE_CM, Stats.SWIM_ONE_CM, Stats.STRIDER_ONE_CM, Stats.NAUTILUS_ONE_CM,
	};

	private volatile JsonObject stats;
	private volatile JsonObject advancements;
	private long nextAt;
	private volatile boolean pending;

	JsonObject stats() {
		return stats;
	}

	JsonObject advancements() {
		return advancements;
	}

	/** Client thread. */
	void tick(Minecraft client) {
		IntegratedServer server = client.getSingleplayerServer();
		if (server == null || client.player == null) {
			stats = null;
			advancements = null;
			nextAt = 0;
			return;
		}
		long now = System.currentTimeMillis();
		if (pending || now < nextAt) return;
		nextAt = now + INTERVAL_MS;
		pending = true;
		UUID id = client.player.getUUID();
		server.execute(() -> {
			try {
				ServerPlayer player = server.getPlayerList().getPlayer(id);
				if (player != null) {
					stats = collectStats(player.getStats());
					advancements = collectAdvancements(server, player);
				}
			} catch (RuntimeException err) {
				McStatusClient.LOG.debug("skipped progress: {}", err.toString());
			} finally {
				pending = false;
			}
		});
	}

	private static JsonObject collectStats(ServerStatsCounter counter) {
		JsonObject out = new JsonObject();
		out.addProperty("play_time", custom(counter, Stats.PLAY_TIME));
		out.addProperty("deaths", custom(counter, Stats.DEATHS));
		out.addProperty("time_since_death", custom(counter, Stats.TIME_SINCE_DEATH));
		out.addProperty("mob_kills", custom(counter, Stats.MOB_KILLS));
		out.addProperty("damage_dealt", custom(counter, Stats.DAMAGE_DEALT));
		out.addProperty("damage_taken", custom(counter, Stats.DAMAGE_TAKEN));
		out.addProperty("jumps", custom(counter, Stats.JUMP));
		out.addProperty("fish_caught", custom(counter, Stats.FISH_CAUGHT));
		out.addProperty("animals_bred", custom(counter, Stats.ANIMALS_BRED));
		out.addProperty("traded", custom(counter, Stats.TRADED_WITH_VILLAGER));
		out.addProperty("enchanted", custom(counter, Stats.ENCHANT_ITEM));
		out.addProperty("slept", custom(counter, Stats.SLEEP_IN_BED));
		out.addProperty("raids_won", custom(counter, Stats.RAID_WIN));
		long travel = 0;
		for (Identifier stat : TRAVEL) travel += custom(counter, stat);
		out.addProperty("travel_cm", travel);
		out.addProperty("flown_cm", custom(counter, Stats.AVIATE_ONE_CM));

		var mined = top(counter, Stats.BLOCK_MINED);
		out.addProperty("blocks_mined", mined.total);
		if (mined.best != null) out.add("top_mined", entry(itemId(mined.best.getValue().asItem()), mined.bestCount));
		var crafted = top(counter, Stats.ITEM_CRAFTED);
		out.addProperty("items_crafted", crafted.total);
		if (crafted.best != null) out.add("top_crafted", entry(itemId(crafted.best.getValue()), crafted.bestCount));
		var killed = top(counter, Stats.ENTITY_KILLED);
		if (killed.best != null) out.add("top_killed", entry(BuiltInRegistries.ENTITY_TYPE.getKey(killed.best.getValue()).toString(), killed.bestCount));
		var killedBy = top(counter, Stats.ENTITY_KILLED_BY);
		if (killedBy.best != null) out.add("top_killed_by", entry(BuiltInRegistries.ENTITY_TYPE.getKey(killedBy.best.getValue()).toString(), killedBy.bestCount));
		return out;
	}

	private static int custom(ServerStatsCounter counter, Identifier id) {
		return counter.getValue(Stats.CUSTOM, id);
	}

	private static <T> TopOf<T> top(ServerStatsCounter counter, StatType<T> type) {
		long total = 0;
		Stat<T> best = null;
		int bestCount = 0;
		// only iterates stats that have been created, i.e. seen by the game
		for (Stat<T> stat : type) {
			int value = counter.getValue(stat);
			total += value;
			if (value > bestCount) {
				best = stat;
				bestCount = value;
			}
		}
		return new TopOf<>(total, best, bestCount);
	}

	private record TopOf<T>(long total, Stat<T> best, int bestCount) {}

	private static JsonObject entry(String id, int count) {
		JsonObject out = new JsonObject();
		out.addProperty("id", id);
		out.addProperty("count", count);
		return out;
	}

	private static String itemId(net.minecraft.world.item.Item item) {
		return BuiltInRegistries.ITEM.getKey(item).toString();
	}

	private record Done(AdvancementHolder holder, DisplayInfo display, Instant at) {}

	private record Partial(AdvancementHolder holder, DisplayInfo display, AdvancementProgress progress) {}

	private static JsonObject collectAdvancements(IntegratedServer server, ServerPlayer player) {
		int done = 0;
		int total = 0;
		Map<String, int[]> tabs = new TreeMap<>();
		List<Done> finished = new ArrayList<>();
		List<Partial> partial = new ArrayList<>();
		List<Partial> checklists = new ArrayList<>();

		for (AdvancementHolder holder : server.getAdvancements().getAllAdvancements()) {
			DisplayInfo display = holder.value().display().orElse(null);
			if (display == null) continue; // recipe unlocks and other invisible ones
			AdvancementProgress progress = player.getAdvancements().getOrStartProgress(holder);
			total++;
			// hidden ones only once started: their names would be spoilers
			if (isChecklist(holder) && (!display.isHidden() || progress.hasProgress())) {
				checklists.add(new Partial(holder, display, progress));
			}
			int[] tab = tabs.computeIfAbsent(tabOf(holder.id()), key -> new int[2]);
			tab[1]++;
			if (progress.isDone()) {
				done++;
				tab[0]++;
				finished.add(new Done(holder, display, lastObtained(progress)));
			} else if (progress.hasProgress() && !display.isHidden()) {
				partial.add(new Partial(holder, display, progress));
			}
		}

		JsonObject out = new JsonObject();
		out.addProperty("done", done);
		out.addProperty("total", total);
		JsonObject tabsJson = new JsonObject();
		tabs.forEach((name, counts) -> {
			JsonArray pair = new JsonArray();
			pair.add(counts[0]);
			pair.add(counts[1]);
			tabsJson.add(name, pair);
		});
		out.add("tabs", tabsJson);

		finished.sort(Comparator.<Done, Instant>comparing(Done::at, Comparator.nullsFirst(Comparator.<Instant>naturalOrder())).reversed());
		JsonArray recent = new JsonArray();
		for (Done item : finished.subList(0, Math.min(RECENT, finished.size()))) {
			JsonObject json = describe(item.holder, item.display);
			if (item.at != null) json.addProperty("at", item.at.toEpochMilli());
			recent.add(json);
		}
		out.add("recent", recent);

		partial.sort(Comparator.comparingDouble((Partial item) -> item.progress.getPercent()).reversed());
		JsonArray going = new JsonArray();
		for (Partial item : partial.subList(0, Math.min(IN_PROGRESS, partial.size()))) {
			JsonObject json = describe(item.holder, item.display);
			json.addProperty("percent", Math.round(item.progress.getPercent() * 100) / 100.0);
			Component text = item.progress.getProgressText();
			if (text != null) json.addProperty("progress", text.getString());
			going.add(json);
		}
		out.add("in_progress", going);

		// unfinished first, closest to done on top; finished ones last
		checklists.sort(Comparator.comparing((Partial item) -> item.progress.isDone())
			.thenComparing(Comparator.comparingDouble((Partial item) -> item.progress.getPercent()).reversed()));
		JsonArray lists = new JsonArray();
		for (Partial item : checklists) {
			JsonObject json = describe(item.holder, item.display);
			json.add("done", names(item.progress.getCompletedCriteria()));
			json.add("missing", names(item.progress.getRemainingCriteria()));
			lists.add(json);
		}
		out.add("checklists", lists);
		return out;
	}

	/**
	 * "Do all of these" advancements, like Adventuring Time (every biome) or
	 * A Balanced Diet (every food): each requirement is exactly one criterion.
	 * Detected from the data, so datapack checklists show up too.
	 */
	private static boolean isChecklist(AdvancementHolder holder) {
		List<List<String>> groups = holder.value().requirements().requirements();
		if (groups.size() < 2) return false;
		for (List<String> group : groups) if (group.size() != 1) return false;
		return true;
	}

	private static JsonArray names(Iterable<String> criteria) {
		List<String> sorted = new ArrayList<>();
		criteria.forEach(sorted::add);
		sorted.sort(null);
		JsonArray out = new JsonArray();
		sorted.forEach(out::add);
		return out;
	}

	/** "minecraft:story/mine_stone" → "story". */
	private static String tabOf(Identifier id) {
		String path = id.getPath();
		int slash = path.indexOf('/');
		return slash > 0 ? path.substring(0, slash) : path;
	}

	private static Instant lastObtained(AdvancementProgress progress) {
		Instant last = null;
		for (String name : progress.getCompletedCriteria()) {
			CriterionProgress criterion = progress.getCriterion(name);
			Instant at = criterion == null ? null : criterion.getObtained();
			if (at != null && (last == null || at.isAfter(last))) last = at;
		}
		return last;
	}

	private static JsonObject describe(AdvancementHolder holder, DisplayInfo display) {
		JsonObject json = new JsonObject();
		json.addProperty("id", holder.id().toString());
		json.addProperty("title", display.getTitle().getString());
		json.addProperty("description", display.getDescription().getString());
		json.addProperty("type", display.getType().getSerializedName());
		ItemStack icon = display.getIcon().create();
		json.addProperty("icon", itemId(icon.isEmpty() ? Items.BARRIER : icon.getItem()));
		if (icon.hasFoil()) json.addProperty("glint", true);
		return json;
	}
}
