import React from "react";

import { createApplicationController } from "./app/application-controller.js";
import { config } from "./config.js";
import { createServer } from "./server.js";
import { renderTui } from "./tui/index.js";

const smoke = process.argv.includes("--smoke");

if (!smoke && (!process.stdin.isTTY || !process.stdout.isTTY)) {
  console.error(
    "LiveTranslating TUI requires an interactive terminal. Run with --smoke for a non-interactive health check.",
  );
  process.exit(1);
}

const controller = await createApplicationController(process.cwd());

if (smoke) {
  const snapshot = controller.getSnapshot();
  console.log(
    JSON.stringify(
      {
        running: snapshot.running,
        microphones: snapshot.microphoneDevices.map((device) => device.label),
        model: snapshot.model,
        reviewer: snapshot.reviewerEnabled,
      },
      null,
      2,
    ),
  );
  await controller.shutdown();
  process.exit(0);
}

const server = await createServer(config, false, controller.translationProvider);
await server.listen({ host: config.host, port: config.port });

const tui = renderTui(controller, {
  title: "LiveTranslating TUI",
  onError: (error) => server.log.error(error),
});

try {
  await tui.waitUntilExit();
} finally {
  await controller.shutdown();
  await server.close();
}
