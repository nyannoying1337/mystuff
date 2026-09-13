package mcstatus.server;

import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Collection;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.context.CommandContext;
import net.minecraft.ChatFormatting;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;
import net.minecraft.commands.arguments.GameProfileArgument;
import net.minecraft.network.chat.ClickEvent;
import net.minecraft.network.chat.Component;
import net.minecraft.network.chat.HoverEvent;
import net.minecraft.network.chat.MutableComponent;
import net.minecraft.server.players.NameAndId;

/**
 * /mcstatus link                 your own page (any player)
 * /mcstatus link &lt;player&gt;        someone's page (moderators)
 * /mcstatus admin                the admin page, with every player (server admins)
 *
 * Links arrive as a clickable chat message only the person who asked can see.
 * The keys come from the Worker, which the server authenticates to with its
 * push token, so they never have to be copied into the server's config.
 */
final class LinkCommands {
	private final HttpClient http;
	private final String workerUrl;
	private final String pushToken;
	private final String siteUrl;

	LinkCommands(HttpClient http, String workerUrl, String pushToken, String siteUrl) {
		this.http = http;
		this.workerUrl = workerUrl;
		this.pushToken = pushToken;
		this.siteUrl = siteUrl;
	}

	void register(CommandDispatcher<CommandSourceStack> dispatcher) {
		dispatcher.register(Commands.literal("mcstatus")
			.then(Commands.literal("link")
				.executes(this::ownLink)
				.then(Commands.argument("players", GameProfileArgument.gameProfile())
					.requires(Commands.hasPermission(Commands.LEVEL_GAMEMASTERS))
					.executes(this::playerLinks)))
			.then(Commands.literal("admin")
				.requires(Commands.hasPermission(Commands.LEVEL_ADMINS))
				.executes(this::adminLink)));
	}

	private int ownLink(CommandContext<CommandSourceStack> context) {
		CommandSourceStack source = context.getSource();
		if (!source.isPlayer()) {
			source.sendFailure(Component.literal("Run this as a player, or use /mcstatus link <player>."));
			return 0;
		}
		sendLink(source, requestKey("{\"uuid\":\"" + source.getPlayer().getUUID() + "\"}"),
			"Your page", "Only you can see this. Anyone with the link sees your page.");
		return 1;
	}

	private int playerLinks(CommandContext<CommandSourceStack> context) throws com.mojang.brigadier.exceptions.CommandSyntaxException {
		CommandSourceStack source = context.getSource();
		Collection<NameAndId> profiles = GameProfileArgument.getGameProfiles(context, "players");
		for (NameAndId profile : profiles) {
			UUID id = profile.id();
			sendLink(source, requestKey("{\"uuid\":\"" + id + "\"}"),
				profile.name() + "'s page", "Give this only to " + profile.name() + ".");
		}
		return profiles.size();
	}

	private int adminLink(CommandContext<CommandSourceStack> context) {
		sendLink(context.getSource(), requestKey("{\"admin\":true}"),
			"Admin page (every player)", "Don't share this: it shows everyone, coordinates included.");
		return 1;
	}

	private CompletableFuture<String> requestKey(String body) {
		HttpRequest request = HttpRequest.newBuilder(URI.create(workerUrl + "/server/links"))
			.timeout(Duration.ofSeconds(15))
			.header("Authorization", "Bearer " + pushToken)
			.header("Content-Type", "application/json")
			.POST(HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8))
			.build();
		return http.sendAsync(request, HttpResponse.BodyHandlers.ofString()).thenApply(response -> {
			JsonObject json = JsonParser.parseString(response.body()).getAsJsonObject();
			if (response.statusCode() != 200 || !json.has("key")) {
				throw new IllegalStateException(json.has("error") ? json.get("error").getAsString() : "HTTP " + response.statusCode());
			}
			return json.get("key").getAsString();
		});
	}

	private void sendLink(CommandSourceStack source, CompletableFuture<String> key, String label, String note) {
		if (siteUrl.isEmpty()) {
			source.sendFailure(Component.literal("Set site_url in config/mc-status-server.properties first."));
			return;
		}
		key.whenComplete((value, err) -> source.getServer().execute(() -> {
			if (err != null) {
				Throwable cause = err.getCause() != null ? err.getCause() : err;
				source.sendFailure(Component.literal("Couldn't get a link from the Worker: " + cause.getMessage()));
				return;
			}
			String url = siteUrl + "#key=" + URLEncoder.encode(value, StandardCharsets.UTF_8);
			if (!source.isPlayer()) {
				// server console: no clicking there, so print it
				source.sendSuccess(() -> Component.literal(label + ": " + url), false);
				return;
			}
			MutableComponent link = Component.literal("[Open " + label + "]").withStyle(style -> style
				.withColor(ChatFormatting.GREEN)
				.withUnderlined(true)
				.withClickEvent(new ClickEvent.OpenUrl(URI.create(url)))
				.withHoverEvent(new HoverEvent.ShowText(Component.literal("Opens in your browser. The dialog also lets you copy it."))));
			source.sendSuccess(() -> Component.literal("mc-status: ").withStyle(ChatFormatting.GRAY)
				.append(link)
				.append(Component.literal(" " + note).withStyle(ChatFormatting.GRAY)), false);
		}));
	}
}
