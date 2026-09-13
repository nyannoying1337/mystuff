package mcstatus.server;

import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Consumer;
import java.util.regex.Pattern;

import com.google.gson.JsonObject;
import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSource;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.permissions.LevelBasedPermissionSet;
import net.minecraft.server.players.NameAndId;
import net.minecraft.world.phys.Vec2;
import net.minecraft.world.phys.Vec3;

/**
 * Runs actions from the admin page (opened with the control key) on the server
 * thread. The Worker has already checked them; this checks again, because it's
 * the side that acts. Moderation actions run as vanilla commands so they behave
 * exactly like typing them, including the "[Web admin: Kicked …]" notice ops see.
 */
final class ServerActions {
	// the characters Minecraft allows in names; anything else is refused before a command is built
	private static final Pattern NAME = Pattern.compile("[A-Za-z0-9_]{1,16}");
	private static final Pattern GAME_MODE = Pattern.compile("survival|creative|adventure|spectator");
	private static final int MAX_OUTPUT_LINES = 40;

	private final MinecraftServer server;
	private final Consumer<JsonObject> reply;

	ServerActions(MinecraftServer server, Consumer<JsonObject> reply) {
		this.server = server;
		this.reply = reply;
	}

	/** Called from the link's thread; the work happens on the server thread. */
	void handle(JsonObject message) {
		server.execute(() -> {
			String id = string(message, "id");
			try {
				run(id, message);
			} catch (RuntimeException err) {
				McStatusServer.LOG.warn("web admin action failed: {}", err.toString());
				finish(id, false, "Failed: " + err.getMessage());
			}
		});
	}

	private void run(String id, JsonObject message) {
		String action = string(message, "action");
		if ("command".equals(action)) {
			String command = clean(string(message, "command"), 1000).replaceFirst("^/+", "");
			if (command.isEmpty()) {
				finish(id, false, "Empty command.");
				return;
			}
			audit("ran /" + command);
			command(id, command);
			return;
		}

		Optional<NameAndId> target = target(string(message, "uuid"));
		if (target.isEmpty()) {
			finish(id, false, "This server doesn't know that player.");
			return;
		}
		String name = target.get().name();
		if (!NAME.matcher(name).matches()) {
			finish(id, false, "Can't act on the name \"" + name + "\" from here; use the console.");
			return;
		}
		ServerPlayer online = server.getPlayerList().getPlayer(target.get().id());
		String reason = clean(string(message, "reason"), 200);

		switch (action) {
			case "kick" -> {
				if (online == null) {
					finish(id, false, name + " isn't online.");
					return;
				}
				audit("kicked " + name + (reason.isEmpty() ? "" : ": " + reason));
				command(id, "kick " + name + (reason.isEmpty() ? "" : " " + reason));
			}
			case "ban" -> {
				audit("banned " + name + (reason.isEmpty() ? "" : ": " + reason));
				command(id, "ban " + name + (reason.isEmpty() ? "" : " " + reason));
			}
			case "pardon" -> {
				audit("unbanned " + name);
				command(id, "pardon " + name);
			}
			case "whitelist_add" -> {
				audit("added " + name + " to the whitelist");
				command(id, "whitelist add " + name);
			}
			case "whitelist_remove" -> {
				audit("removed " + name + " from the whitelist");
				command(id, "whitelist remove " + name);
			}
			case "gamemode" -> {
				String mode = string(message, "mode");
				if (!GAME_MODE.matcher(mode).matches()) {
					finish(id, false, "Unknown game mode.");
					return;
				}
				audit("set " + name + "'s game mode to " + mode);
				command(id, "gamemode " + mode + " " + name);
			}
			case "heal", "feed" -> {
				if (online == null) {
					finish(id, false, name + " isn't online.");
					return;
				}
				if ("heal".equals(action)) {
					online.setHealth(online.getMaxHealth());
					online.clearFire();
				} else {
					online.getFoodData().setFoodLevel(20);
					online.getFoodData().setSaturation(20f);
				}
				audit(("heal".equals(action) ? "healed " : "fed ") + name);
				finish(id, true, ("heal".equals(action) ? "Healed " : "Fed ") + name + ".");
			}
			case "message" -> {
				String text = clean(string(message, "text"), 256);
				if (online == null) {
					finish(id, false, name + " isn't online.");
					return;
				}
				if (text.isEmpty()) {
					finish(id, false, "Empty message.");
					return;
				}
				online.sendSystemMessage(Component.literal("[Admin] ").withStyle(ChatFormatting.GOLD)
					.append(Component.literal(text).withStyle(ChatFormatting.WHITE)));
				audit("messaged " + name);
				finish(id, true, "Sent to " + name + ".");
			}
			default -> finish(id, false, "Unknown action.");
		}
	}

	/** Runs a command as "Web admin" with full permissions, collecting what it prints. */
	private void command(String id, String command) {
		List<String> lines = new ArrayList<>();
		boolean[] succeeded = {false};  // stays false if the command doesn't even parse
		CommandSource collector = new CommandSource() {
			@Override
			public void sendSystemMessage(Component message) {
				if (lines.size() < MAX_OUTPUT_LINES) lines.add(message.getString());
			}

			@Override
			public boolean acceptsSuccess() {
				return true;
			}

			@Override
			public boolean acceptsFailure() {
				return true;
			}

			@Override
			public boolean shouldInformAdmins() {
				return true;
			}
		};
		ServerLevel level = server.overworld();
		CommandSourceStack source = new CommandSourceStack(collector, Vec3.ZERO, Vec2.ZERO, level, LevelBasedPermissionSet.OWNER,
			"Web admin", Component.literal("Web admin"), server, null)
			.withCallback((success, result) -> succeeded[0] |= success);
		server.getCommands().performPrefixedCommand(source, command);
		finish(id, succeeded[0], lines.isEmpty() ? (succeeded[0] ? "Done." : "Failed.") : String.join("\n", lines));
	}

	private void finish(String id, boolean ok, String output) {
		JsonObject result = new JsonObject();
		result.addProperty("type", "result");
		result.addProperty("id", id);
		result.addProperty("ok", ok);
		result.addProperty("output", output);
		reply.accept(result);
	}

	// Every web action is written to the log, the way console commands are.
	private void audit(String what) {
		McStatusServer.LOG.info("[Web admin] {}", what);
	}

	private Optional<NameAndId> target(String uuid) {
		UUID id;
		try {
			id = UUID.fromString(uuid);
		} catch (IllegalArgumentException err) {
			return Optional.empty();
		}
		ServerPlayer online = server.getPlayerList().getPlayer(id);
		if (online != null) return Optional.of(new NameAndId(online.getGameProfile()));
		return server.services().nameToIdCache().get(id);
	}

	private static String string(JsonObject json, String key) {
		return json.has(key) && json.get(key).isJsonPrimitive() ? json.get(key).getAsString() : "";
	}

	private static String clean(String value, int max) {
		String out = value.replaceAll("\\p{Cntrl}", "").trim();
		return out.length() > max ? out.substring(0, max) : out;
	}
}
