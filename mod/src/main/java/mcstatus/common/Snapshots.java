package mcstatus.common;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.Function;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import it.unimi.dsi.fastutil.objects.Object2IntMap;
import net.minecraft.advancements.AdvancementHolder;
import net.minecraft.advancements.AdvancementProgress;
import net.minecraft.advancements.CriterionProgress;
import net.minecraft.advancements.DisplayInfo;
import net.minecraft.core.Holder;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.stats.Stat;
import net.minecraft.stats.StatType;
import net.minecraft.stats.Stats;
import net.minecraft.stats.StatsCounter;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.alchemy.PotionContents;
import net.minecraft.world.item.component.DyedItemColor;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.enchantment.Enchantment;
import net.minecraft.world.item.enchantment.ItemEnchantments;

/**
 * The player facts the page shows, as JSON: inventory, statistics, advancements.
 * Shared by the client mod (your own singleplayer world) and the server mod
 * (every player on a server). Call on the server thread.
 */
public final class Snapshots {
	private static final int RECENT = 6;
	private static final int IN_PROGRESS = 4;
	private static final EquipmentSlot[] ARMOR = {EquipmentSlot.HEAD, EquipmentSlot.CHEST, EquipmentSlot.LEGS, EquipmentSlot.FEET};

	/** Distance stats that are travel, in cm. Falling isn't. */
	private static final Identifier[] TRAVEL = {
		Stats.WALK_ONE_CM, Stats.CROUCH_ONE_CM, Stats.SPRINT_ONE_CM, Stats.WALK_ON_WATER_ONE_CM,
		Stats.CLIMB_ONE_CM, Stats.FLY_ONE_CM, Stats.WALK_UNDER_WATER_ONE_CM, Stats.MINECART_ONE_CM,
		Stats.BOAT_ONE_CM, Stats.PIG_ONE_CM, Stats.HAPPY_GHAST_ONE_CM, Stats.HORSE_ONE_CM,
		Stats.AVIATE_ONE_CM, Stats.SWIM_ONE_CM, Stats.STRIDER_ONE_CM, Stats.NAUTILUS_ONE_CM,
	};

	private Snapshots() {}

	// ---------------------------------------------------------------- inventory

	/** hotbar, inventory, armor and offhand, in the shape the page draws. */
	public static void addInventory(JsonObject out, Player player, boolean shareItemNames) {
		Inventory inventory = player.getInventory();
		JsonArray hotbar = new JsonArray();
		JsonArray main = new JsonArray();
		for (int slot = 0; slot < 36; slot++) {
			JsonObject item = item(inventory.getItem(slot), slot, shareItemNames);
			if (item != null) (slot < 9 ? hotbar : main).add(item);
		}
		out.add("hotbar", hotbar);
		out.add("inventory", main);
		JsonObject armor = new JsonObject();
		for (EquipmentSlot slot : ARMOR) {
			JsonObject item = item(player.getItemBySlot(slot), -1, shareItemNames);
			if (item != null) armor.add(slot.getName(), item);
		}
		out.add("armor", armor);
		JsonObject offhand = item(player.getOffhandItem(), -1, shareItemNames);
		if (offhand != null) out.add("offhand", offhand);
	}

	public static JsonObject item(ItemStack stack, int slot, boolean shareItemNames) {
		if (stack.isEmpty()) return null;
		JsonObject item = new JsonObject();
		item.addProperty("id", itemId(stack.getItem()));
		item.addProperty("count", stack.getCount());
		if (slot >= 0) item.addProperty("slot", slot);
		if (stack.isDamageableItem()) {
			item.addProperty("damage", stack.getDamageValue());
			item.addProperty("max_damage", stack.getMaxDamage());
		}
		if (stack.hasFoil()) item.addProperty("enchanted", true);
		// Every potion shares one item id, so the page cannot tell a healing potion from
		// night vision by id alone — and one icon per id cannot show both. The colour
		// travels with the stack instead, and the page tints the icon with it.
		PotionContents potion = stack.get(DataComponents.POTION_CONTENTS);
		if (potion != null) item.addProperty("color", potion.getColor());
		else if (stack.has(DataComponents.DYED_COLOR)) item.addProperty("color", DyedItemColor.getOrDefault(stack, 0));
		JsonArray enchantments = new JsonArray();
		addEnchantments(enchantments, stack.getEnchantments());
		addEnchantments(enchantments, stack.get(DataComponents.STORED_ENCHANTMENTS));
		if (!enchantments.isEmpty()) item.add("enchantments", enchantments);
		// custom names can contain anything, so only when the owner opted in
		if (shareItemNames && stack.has(DataComponents.CUSTOM_NAME)) item.addProperty("name", stack.getHoverName().getString());
		return item;
	}

	private static void addEnchantments(JsonArray out, ItemEnchantments enchantments) {
		if (enchantments == null || enchantments.isEmpty()) return;
		for (Object2IntMap.Entry<Holder<Enchantment>> entry : enchantments.entrySet()) {
			JsonObject enchantment = new JsonObject();
			enchantment.addProperty("id", entry.getKey().getRegisteredName());
			enchantment.addProperty("level", entry.getIntValue());
			out.add(enchantment);
		}
	}

	/** Where the player last died, or null. Coordinates: callers decide who may see them. */
	public static JsonObject lastDeath(Player player) {
		return player.getLastDeathLocation().map(death -> {
			JsonObject spot = new JsonObject();
			spot.addProperty("dimension", death.dimension().identifier().toString());
			JsonArray at = new JsonArray();
			at.add(death.pos().getX());
			at.add(death.pos().getY());
			at.add(death.pos().getZ());
			spot.add("position", at);
			return spot;
		}).orElse(null);
	}

	// ---------------------------------------------------------------- statistics

	/** Works on a live player's counter, and on one loaded from a stats file. */
	public static JsonObject stats(StatsCounter counter) {
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

	private static int custom(StatsCounter counter, Identifier id) {
		return counter.getValue(Stats.CUSTOM, id);
	}

	private record TopOf<T>(long total, Stat<T> best, int bestCount) {}

	private static <T> TopOf<T> top(StatsCounter counter, StatType<T> type) {
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

	private static JsonObject entry(String id, int count) {
		JsonObject out = new JsonObject();
		out.addProperty("id", id);
		out.addProperty("count", count);
		return out;
	}

	private static String itemId(Item item) {
		return BuiltInRegistries.ITEM.getKey(item).toString();
	}

	// ---------------------------------------------------------------- advancements

	/** One advancement's progress, from a live player or from their saved file. */
	public interface AdvancementView {
		boolean done();
		boolean started();
		Collection<String> completed();
		Collection<String> remaining();
		float percent();
		Instant lastObtained();
		String progressText();
	}

	public static AdvancementView live(AdvancementProgress progress) {
		return new AdvancementView() {
			public boolean done() { return progress.isDone(); }
			public boolean started() { return progress.hasProgress(); }
			public Collection<String> completed() { return list(progress.getCompletedCriteria()); }
			public Collection<String> remaining() { return list(progress.getRemainingCriteria()); }
			public float percent() { return progress.getPercent(); }
			public String progressText() {
				Component text = progress.getProgressText();
				return text == null ? null : text.getString();
			}
			public Instant lastObtained() {
				Instant last = null;
				for (String name : progress.getCompletedCriteria()) {
					CriterionProgress criterion = progress.getCriterion(name);
					Instant at = criterion == null ? null : criterion.getObtained();
					if (at != null && (last == null || at.isAfter(last))) last = at;
				}
				return last;
			}
		};
	}

	/**
	 * An offline player's progress from world/advancements/&lt;uuid&gt;.json:
	 * {"minecraft:story/root": {"criteria": {"crafting_table": "2026-09-13 18:00:00 +0200"}, "done": true}}.
	 */
	public static Function<AdvancementHolder, AdvancementView> fromFile(JsonObject file) {
		return holder -> {
			JsonElement element = file.get(holder.id().toString());
			JsonObject entry = element != null && element.isJsonObject() ? element.getAsJsonObject() : new JsonObject();
			JsonObject criteria = entry.has("criteria") && entry.get("criteria").isJsonObject() ? entry.getAsJsonObject("criteria") : new JsonObject();
			List<String> completed = new ArrayList<>(criteria.keySet());
			List<String> remaining = new ArrayList<>();
			for (String name : holder.value().criteria().keySet()) if (!criteria.has(name)) remaining.add(name);
			int requirements = Math.max(1, holder.value().requirements().size());
			long groupsDone = holder.value().requirements().requirements().stream()
				.filter(group -> group.stream().anyMatch(criteria::has)).count();
			boolean done = entry.has("done") && entry.get("done").getAsBoolean();
			return new AdvancementView() {
				public boolean done() { return done; }
				public boolean started() { return !completed.isEmpty(); }
				public Collection<String> completed() { return completed; }
				public Collection<String> remaining() { return remaining; }
				public float percent() { return (float) groupsDone / requirements; }
				public Instant lastObtained() { return null; }
				public String progressText() { return requirements > 1 ? groupsDone + "/" + requirements : null; }
			};
		};
	}

	private record Row(AdvancementHolder holder, DisplayInfo display, AdvancementView progress, Instant at) {}

	public static JsonObject advancements(MinecraftServer server, Function<AdvancementHolder, AdvancementView> progressOf) {
		int done = 0;
		int total = 0;
		Map<String, int[]> tabs = new TreeMap<>();
		List<Row> finished = new ArrayList<>();
		List<Row> partial = new ArrayList<>();
		List<Row> checklists = new ArrayList<>();

		for (AdvancementHolder holder : server.getAdvancements().getAllAdvancements()) {
			DisplayInfo display = holder.value().display().orElse(null);
			if (display == null) continue; // recipe unlocks and other invisible ones
			AdvancementView progress = progressOf.apply(holder);
			total++;
			int[] tab = tabs.computeIfAbsent(tabOf(holder.id()), key -> new int[2]);
			tab[1]++;
			// hidden ones only once started: their names would be spoilers
			if (isChecklist(holder) && (!display.isHidden() || progress.started())) {
				checklists.add(new Row(holder, display, progress, null));
			}
			if (progress.done()) {
				done++;
				tab[0]++;
				finished.add(new Row(holder, display, progress, progress.lastObtained()));
			} else if (progress.started() && !display.isHidden()) {
				partial.add(new Row(holder, display, progress, null));
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

		finished.sort(Comparator.<Row, Instant>comparing(Row::at, Comparator.nullsFirst(Comparator.<Instant>naturalOrder())).reversed());
		JsonArray recent = new JsonArray();
		for (Row row : finished.subList(0, Math.min(RECENT, finished.size()))) {
			JsonObject json = describe(row.holder, row.display);
			if (row.at != null) json.addProperty("at", row.at.toEpochMilli());
			recent.add(json);
		}
		out.add("recent", recent);

		partial.sort(Comparator.comparingDouble((Row row) -> row.progress.percent()).reversed());
		JsonArray going = new JsonArray();
		for (Row row : partial.subList(0, Math.min(IN_PROGRESS, partial.size()))) {
			JsonObject json = describe(row.holder, row.display);
			json.addProperty("percent", Math.round(row.progress.percent() * 100) / 100.0);
			String text = row.progress.progressText();
			if (text != null) json.addProperty("progress", text);
			going.add(json);
		}
		out.add("in_progress", going);

		// unfinished first, closest to done on top; finished ones last
		checklists.sort(Comparator.comparing((Row row) -> row.progress.done())
			.thenComparing(Comparator.comparingDouble((Row row) -> row.progress.percent()).reversed()));
		JsonArray lists = new JsonArray();
		for (Row row : checklists) {
			JsonObject json = describe(row.holder, row.display);
			json.add("done", sorted(row.progress.completed()));
			json.add("missing", sorted(row.progress.remaining()));
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

	/** "minecraft:story/mine_stone" → "story". */
	private static String tabOf(Identifier id) {
		String path = id.getPath();
		int slash = path.indexOf('/');
		return slash > 0 ? path.substring(0, slash) : path;
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

	private static List<String> list(Iterable<String> names) {
		List<String> out = new ArrayList<>();
		names.forEach(out::add);
		return out;
	}

	private static JsonArray sorted(Collection<String> names) {
		List<String> copy = new ArrayList<>(names);
		copy.sort(null);
		JsonArray out = new JsonArray();
		copy.forEach(out::add);
		return out;
	}
}
