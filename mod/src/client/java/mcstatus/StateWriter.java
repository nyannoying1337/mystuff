package mcstatus;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import it.unimi.dsi.fastutil.objects.Object2IntMap;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.core.Holder;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.util.Util;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.enchantment.Enchantment;
import net.minecraft.world.item.enchantment.ItemEnchantments;
import net.minecraft.world.level.storage.LevelResource;

/**
 * Writes the player's state to state.json. Only what the page shows is
 * collected — no chat, no server address, no other players.
 */
final class StateWriter {
	private static final Gson GSON = new Gson();
	private static final long HEARTBEAT_MS = 5000;
	private static final EquipmentSlot[] ARMOR = {EquipmentSlot.HEAD, EquipmentSlot.CHEST, EquipmentSlot.LEGS, EquipmentSlot.FEET};

	private final Path file;
	private final ModConfig config;
	private final Progress progress;
	private int ticks;
	private long joinedAt;
	private JsonObject last;
	private String lastBody = "";
	private long lastWrittenAt;

	StateWriter(Path file, ModConfig config, Progress progress) {
		this.file = file;
		this.config = config;
		this.progress = progress;
	}

	void tick(Minecraft client) {
		if (++ticks < config.stateIntervalTicks) return;
		ticks = 0;
		LocalPlayer player = client.player;
		if (player == null || client.level == null) return;
		if (joinedAt == 0) joinedAt = System.currentTimeMillis();

		JsonObject state = snapshot(client, player);
		// The clock, FPS and memory change every second. They don't count as a
		// change on their own: they're added after the check and ride along with
		// real changes or the heartbeat. That's ~5× fewer writes while standing still.
		String body = GSON.toJson(state);
		long now = System.currentTimeMillis();
		// Unchanged state is still rewritten now and then, so the agent can tell
		// a quiet player from a crashed game.
		if (body.equals(lastBody) && now - lastWrittenAt < HEARTBEAT_MS) return;

		last = state;
		lastBody = body;
		lastWrittenAt = now;
		state.add("game", game(client, client.getSingleplayerServer()));
		if (state.has("world")) {
			long time = client.level.getOverworldClockTime();
			JsonObject world = state.getAsJsonObject("world");
			world.addProperty("day", time / 24000);
			world.addProperty("time", Math.floorMod(time, 24000L));
		}
		state.addProperty("joined_at", joinedAt);
		state.addProperty("written_at", now);
		String json = GSON.toJson(state);
		Util.ioPool().execute(() -> write(json));
	}

	/** Called on disconnect and shutdown: keep the last inventory, flag it offline. */
	void markOffline() {
		joinedAt = 0;
		if (last == null) return;
		JsonObject state = last.deepCopy();
		state.addProperty("online", false);
		state.addProperty("written_at", System.currentTimeMillis());
		last = null;
		lastBody = "";
		// Synchronous: at shutdown the io pool may already be gone.
		write(GSON.toJson(state));
	}

	private void write(String json) {
		try {
			AtomicFiles.write(file, temp -> Files.writeString(temp, json, StandardCharsets.UTF_8));
		} catch (IOException err) {
			McStatusClient.LOG.warn("could not write {}: {}", file, err.getMessage());
		}
	}

	private JsonObject snapshot(Minecraft client, LocalPlayer player) {
		JsonObject state = new JsonObject();
		state.addProperty("online", true);
		state.addProperty("name", player.getGameProfile().name());
		state.addProperty("health", player.getHealth());
		state.addProperty("foodlevel", player.getFoodData().getFoodLevel());
		state.addProperty("xplevel", player.experienceLevel);
		state.addProperty("xpp", player.experienceProgress);
		state.addProperty("dimension", player.level().dimension().identifier().toString());

		JsonArray position = new JsonArray();
		position.add(Math.round(player.getX() * 10) / 10.0);
		position.add(Math.round(player.getY() * 10) / 10.0);
		position.add(Math.round(player.getZ() * 10) / 10.0);
		state.add("position", position);
		JsonArray rotation = new JsonArray();
		rotation.add(Math.round(player.getYRot() * 10) / 10.0);
		rotation.add(Math.round(player.getXRot() * 10) / 10.0);
		state.add("rotation", rotation);

		// The agent only renders maps and runs curses for singleplayer sessions.
		// For servers nothing identifying is written — not even the address.
		IntegratedServer server = client.getSingleplayerServer();
		state.addProperty("mode", server != null ? "singleplayer" : "multiplayer");
		if (server != null) {
			state.addProperty("world_path", server.getWorldPath(LevelResource.ROOT).toAbsolutePath().normalize().toString());
			state.add("world", world(client, server, player));
			// for the map's death marker; coordinates, so own worlds only
			player.getLastDeathLocation().ifPresent(death -> {
				JsonObject spot = new JsonObject();
				spot.addProperty("dimension", death.dimension().identifier().toString());
				JsonArray at = new JsonArray();
				at.add(death.pos().getX());
				at.add(death.pos().getY());
				at.add(death.pos().getZ());
				spot.add("position", at);
				state.add("last_death", spot);
			});
			JsonObject stats = progress.stats();
			if (stats != null) state.add("stats", stats);
			JsonObject advancements = progress.advancements();
			if (advancements != null) state.add("advancements", advancements);
		}

		Inventory inventory = player.getInventory();
		JsonArray hotbar = new JsonArray();
		JsonArray main = new JsonArray();
		for (int slot = 0; slot < 36; slot++) {
			JsonObject item = item(inventory.getItem(slot), slot);
			if (item != null) (slot < 9 ? hotbar : main).add(item);
		}
		state.add("hotbar", hotbar);
		state.add("inventory", main);

		JsonObject armor = new JsonObject();
		for (EquipmentSlot slot : ARMOR) {
			JsonObject item = item(player.getItemBySlot(slot), -1);
			if (item != null) armor.add(slot.getName(), item);
		}
		state.add("armor", armor);
		JsonObject offhand = item(player.getOffhandItem(), -1);
		if (offhand != null) state.add("offhand", offhand);
		return state;
	}

	/** Singleplayer only: the world you're in, without its seed or location on disk. */
	private static JsonObject world(Minecraft client, IntegratedServer server, LocalPlayer player) {
		ClientLevel level = client.level;
		JsonObject world = new JsonObject();
		world.addProperty("name", server.getWorldData().getLevelName());
		world.addProperty("weather", level.isThundering() ? "thunder" : level.isRaining() ? "rain" : "clear");
		level.getBiome(player.blockPosition()).unwrapKey()
			.ifPresent(key -> world.addProperty("biome", key.identifier().toString()));
		world.addProperty("difficulty", level.getLevelData().getDifficulty().getSerializedName());
		world.addProperty("hardcore", level.getLevelData().isHardcore());
		if (client.gameMode != null) world.addProperty("game_mode", client.gameMode.getPlayerMode().getName());
		world.addProperty("armor", player.getArmorValue());
		return world;
	}

	/** How the game itself is running. Rounded so it doesn't rewrite the file every tick. */
	private static JsonObject game(Minecraft client, IntegratedServer server) {
		JsonObject game = new JsonObject();
		game.addProperty("fps", client.getFps());
		Runtime runtime = Runtime.getRuntime();
		game.addProperty("mem_used_mb", (runtime.totalMemory() - runtime.freeMemory()) >> 20);
		game.addProperty("mem_max_mb", runtime.maxMemory() >> 20);
		if (server != null) game.addProperty("mspt", Math.round(server.getAverageTickTimeNanos() / 1e5) / 10.0);
		return game;
	}

	private JsonObject item(ItemStack stack, int slot) {
		if (stack.isEmpty()) return null;
		JsonObject item = new JsonObject();
		item.addProperty("id", BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
		item.addProperty("count", stack.getCount());
		if (slot >= 0) item.addProperty("slot", slot);
		if (stack.isDamageableItem()) {
			item.addProperty("damage", stack.getDamageValue());
			item.addProperty("max_damage", stack.getMaxDamage());
		}
		if (stack.hasFoil()) item.addProperty("enchanted", true);

		JsonArray enchantments = new JsonArray();
		addEnchantments(enchantments, stack.getEnchantments());
		addEnchantments(enchantments, stack.get(DataComponents.STORED_ENCHANTMENTS));
		if (!enchantments.isEmpty()) item.add("enchantments", enchantments);

		if (config.shareItemNames && stack.has(DataComponents.CUSTOM_NAME)) {
			item.addProperty("name", stack.getHoverName().getString());
		}
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
}
