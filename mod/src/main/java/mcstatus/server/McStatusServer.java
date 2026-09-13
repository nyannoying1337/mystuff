package mcstatus.server;

import java.io.IOException;
import java.io.Reader;
import java.io.Writer;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.stream.Stream;

import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import mcstatus.common.Snapshots;
import net.fabricmc.api.DedicatedServerModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.stats.ServerStatsCounter;
import net.minecraft.world.level.storage.LevelResource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * PROOF OF CONCEPT. The server side of mc-status: every player on a Fabric
 * server, for an admin page and per-player pages.
 *
 * <p>Every few seconds, on the server thread, it snapshots the server and each
 * online player (vitals, position, inventory, statistics, advancements), plus
 * players who aren't online from their saved stats and advancements files. The
 * JSON is sent to the Worker's /server/status off the server thread.
 */
public class McStatusServer implements DedicatedServerModInitializer {
	public static final Logger LOG = LoggerFactory.getLogger("mc-status-server");
	private static final Gson GSON = new Gson();
	private static final long OFFLINE_REFRESH_MS = 5 * 60 * 1000;

	private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
	private final AtomicBoolean sending = new AtomicBoolean();
	private final Map<UUID, JsonObject> offline = new HashMap<>();
	private long offlineReadAt;
	private long nextPushAt;
	private String workerUrl;
	private String pushToken;
	private String serverName;
	private int intervalSeconds;
	private boolean shareItemNames;

	@Override
	public void onInitializeServer() {
		Path file = FabricLoader.getInstance().getConfigDir().resolve("mc-status-server.properties");
		Properties props = loadConfig(file);
		workerUrl = props.getProperty("worker_url", "").replaceAll("/+$", "");
		pushToken = props.getProperty("push_token", "");
		serverName = props.getProperty("server_name", "Minecraft server");
		intervalSeconds = Math.max(5, Integer.parseInt(props.getProperty("interval_seconds", "10").trim()));
		shareItemNames = Boolean.parseBoolean(props.getProperty("share_item_names", "false").trim());
		if (workerUrl.isEmpty() || pushToken.isEmpty()) {
			LOG.warn("set worker_url and push_token in {} to start publishing", file);
			return;
		}
		ServerTickEvents.END_SERVER_TICK.register(this::tick);
		LOG.info("publishing {} to {} every {}s", serverName, workerUrl, intervalSeconds);
	}

	private void tick(MinecraftServer server) {
		long now = System.currentTimeMillis();
		if (now < nextPushAt || sending.get()) return;
		nextPushAt = now + intervalSeconds * 1000L;
		String body;
		try {
			body = GSON.toJson(snapshot(server, now));
		} catch (RuntimeException err) {
			LOG.warn("snapshot failed: {}", err.toString());
			return;
		}
		sending.set(true);
		HttpRequest request = HttpRequest.newBuilder(URI.create(workerUrl + "/server/status"))
			.timeout(Duration.ofSeconds(20))
			.header("Authorization", "Bearer " + pushToken)
			.header("Content-Type", "application/json")
			.POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
			.build();
		http.sendAsync(request, HttpResponse.BodyHandlers.discarding()).whenComplete((response, err) -> {
			sending.set(false);
			if (err != null) LOG.warn("push failed: {}", err.toString());
			else if (response.statusCode() >= 300) LOG.warn("push refused: HTTP {}", response.statusCode());
			else LOG.debug("pushed {} bytes", body.length());
		});
	}

	private JsonObject snapshot(MinecraftServer server, long now) {
		JsonObject out = new JsonObject();
		JsonObject meta = new JsonObject();
		meta.addProperty("name", serverName);
		meta.addProperty("version", server.getServerVersion());
		meta.addProperty("players_online", server.getPlayerCount());
		meta.addProperty("max_players", server.getMaxPlayers());
		double mspt = server.getAverageTickTimeNanos() / 1e6;
		meta.addProperty("mspt", Math.round(mspt * 10) / 10.0);
		meta.addProperty("tps", Math.round(Math.min(20, 1000 / Math.max(mspt, 50)) * 10) / 10.0);
		ServerLevel overworld = server.overworld();
		long time = overworld.getOverworldClockTime();
		meta.addProperty("day", time / 24000);
		meta.addProperty("time", Math.floorMod(time, 24000L));
		meta.addProperty("weather", overworld.isThundering() ? "thunder" : overworld.isRaining() ? "rain" : "clear");
		meta.addProperty("generated_at", now);
		out.add("server", meta);

		JsonArray players = new JsonArray();
		Set<UUID> online = new HashSet<>();
		for (ServerPlayer player : server.getPlayerList().getPlayers()) {
			online.add(player.getUUID());
			players.add(onlinePlayer(server, player));
		}
		if (now - offlineReadAt > OFFLINE_REFRESH_MS) {
			offlineReadAt = now;
			readOfflinePlayers(server);
		}
		offline.forEach((id, player) -> {
			if (!online.contains(id)) players.add(player);
		});
		out.add("players", players);
		return out;
	}

	private JsonObject onlinePlayer(MinecraftServer server, ServerPlayer player) {
		JsonObject json = new JsonObject();
		json.addProperty("uuid", player.getUUID().toString());
		json.addProperty("name", player.getGameProfile().name());
		json.addProperty("online", true);
		json.addProperty("health", player.getHealth());
		json.addProperty("foodlevel", player.getFoodData().getFoodLevel());
		json.addProperty("xplevel", player.experienceLevel);
		json.addProperty("xpp", player.experienceProgress);
		json.addProperty("game_mode", player.gameMode().getName());
		json.addProperty("ping", player.connection.latency());
		json.addProperty("dimension", player.level().dimension().identifier().toString());
		JsonArray position = new JsonArray();
		position.add(Math.round(player.getX() * 10) / 10.0);
		position.add(Math.round(player.getY() * 10) / 10.0);
		position.add(Math.round(player.getZ() * 10) / 10.0);
		json.add("position", position);
		JsonObject world = new JsonObject();
		world.addProperty("armor", player.getArmorValue());
		json.add("world", world);
		Snapshots.addInventory(json, player, shareItemNames);
		JsonObject death = Snapshots.lastDeath(player);
		if (death != null) json.add("last_death", death);
		json.add("stats", Snapshots.stats(player.getStats()));
		json.add("advancements", Snapshots.advancements(server, holder -> Snapshots.live(player.getAdvancements().getOrStartProgress(holder))));
		return json;
	}

	/** Players who aren't here: from world/stats and world/advancements, named via usercache. */
	private void readOfflinePlayers(MinecraftServer server) {
		offline.clear();
		Path statsDir = server.getWorldPath(LevelResource.PLAYER_STATS_DIR);
		Path advancementsDir = server.getWorldPath(LevelResource.PLAYER_ADVANCEMENTS_DIR);
		List<Path> files = new ArrayList<>();
		try (Stream<Path> stream = Files.list(statsDir)) {
			stream.filter(path -> path.toString().endsWith(".json")).forEach(files::add);
		} catch (IOException err) {
			return; // no stats yet
		}
		for (Path statsFile : files) {
			String name = statsFile.getFileName().toString().replace(".json", "");
			UUID id;
			try {
				id = UUID.fromString(name);
			} catch (IllegalArgumentException err) {
				continue;
			}
			JsonObject json = new JsonObject();
			json.addProperty("uuid", id.toString());
			json.addProperty("name", server.services().nameToIdCache().get(id).map(profile -> profile.name()).orElse(id.toString().substring(0, 8)));
			json.addProperty("online", false);
			try {
				json.addProperty("last_seen", Files.getLastModifiedTime(statsFile).toMillis());
				json.add("stats", Snapshots.stats(new ServerStatsCounter(server, statsFile)));
				Path advancementsFile = advancementsDir.resolve(id + ".json");
				if (Files.isRegularFile(advancementsFile)) {
					try (Reader reader = Files.newBufferedReader(advancementsFile, StandardCharsets.UTF_8)) {
						JsonObject saved = JsonParser.parseReader(reader).getAsJsonObject();
						json.add("advancements", Snapshots.advancements(server, Snapshots.fromFile(saved)));
					}
				}
			} catch (IOException | RuntimeException err) {
				LOG.debug("could not read saved data for {}: {}", id, err.toString());
			}
			offline.put(id, json);
		}
	}

	private static Properties loadConfig(Path file) {
		Properties props = new Properties();
		if (Files.isRegularFile(file)) {
			try (Reader reader = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
				props.load(reader);
			} catch (IOException err) {
				LOG.warn("could not read {}: {}", file, err.getMessage());
			}
			return props;
		}
		try (Writer writer = Files.newBufferedWriter(file, StandardCharsets.UTF_8)) {
			writer.write("""
				# mc-status server (proof of concept)
				# The Worker to publish to, and its PUSH_TOKEN secret.
				worker_url=
				push_token=
				# Shown at the top of the admin page.
				server_name=Minecraft server
				interval_seconds=10
				# Custom item names can contain anything players type.
				share_item_names=false
				""");
		} catch (IOException err) {
			LOG.warn("could not write {}: {}", file, err.getMessage());
		}
		return props;
	}
}
