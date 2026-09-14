package mcstatus;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import mcstatus.common.Snapshots;
import net.fabricmc.loader.api.FabricLoader;
import net.fabricmc.loader.api.ModContainer;
import net.fabricmc.loader.api.metadata.ModMetadata;
import net.minecraft.client.Minecraft;
import net.minecraft.client.multiplayer.ClientLevel;
import net.minecraft.client.player.LocalPlayer;
import net.minecraft.client.server.IntegratedServer;
import net.minecraft.util.Util;
import net.minecraft.world.level.storage.LevelResource;

/**
 * Writes the player's state to state.json. Only what the page shows is
 * collected — no chat, no server address, no other players.
 */
final class StateWriter {
	private static final Gson GSON = new Gson();
	private static final long HEARTBEAT_MS = 5000;
	/** The loaded mods can't change while the game runs, so they're read once. */
	private static JsonArray modList;

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
			JsonObject death = Snapshots.lastDeath(player);
			if (death != null) state.add("last_death", death);
			JsonObject stats = progress.stats();
			if (stats != null) state.add("stats", stats);
			JsonObject advancements = progress.advancements();
			if (advancements != null) state.add("advancements", advancements);
		}

		if (config.shareMods) state.add("mods", mods());

		Snapshots.addInventory(state, player, config.shareItemNames);
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
		if (server != null) {
			double mspt = server.getAverageTickTimeNanos() / 1e6;
			game.addProperty("mspt", Math.round(mspt * 10) / 10.0);
			// A tick is 50 ms, so 20 per second is the ceiling: only ticks that
			// overrun bring it down. Below 20 the world itself is running slow.
			game.addProperty("tps", Math.round(1000.0 / Math.max(mspt, 50.0) * 10) / 10.0);
		}
		if (client.level != null) {
			game.addProperty("entities", client.level.getEntityCount());
			game.addProperty("chunks", client.level.getChunkSource().getLoadedChunksCount());
		}
		game.addProperty("render_distance", client.options.renderDistance().get());
		return game;
	}

	/**
	 * Installed mods, as id, name and version. Fabric's builtin containers (java,
	 * minecraft, the loader) and nested ones are skipped, so the list is the mods
	 * that were actually installed rather than every library submodule inside them.
	 */
	private static JsonArray mods() {
		if (modList != null) return modList;
		List<JsonObject> found = new ArrayList<>();
		for (ModContainer container : FabricLoader.getInstance().getAllMods()) {
			ModMetadata meta = container.getMetadata();
			if ("builtin".equals(meta.getType()) || container.getContainingMod().isPresent()) continue;
			JsonObject mod = new JsonObject();
			mod.addProperty("id", meta.getId());
			mod.addProperty("name", meta.getName());
			mod.addProperty("version", meta.getVersion().getFriendlyString());
			found.add(mod);
		}
		found.sort(Comparator.comparing((JsonObject mod) -> mod.get("name").getAsString().toLowerCase(Locale.ROOT)));
		JsonArray mods = new JsonArray();
		found.forEach(mods::add);
		modList = mods;
		return mods;
	}
}
