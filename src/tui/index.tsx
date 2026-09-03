import React from "react";
import { render, type Instance } from "ink";

import { TuiApp, type TuiAppProps } from "./app.js";

export * from "./controller.js";
export { TuiApp, type TuiAppProps } from "./app.js";

export interface RenderTuiOptions {
  readonly title?: string;
  readonly onError?: (error: unknown) => void;
}

export function renderTui(
  controller: TuiAppProps["controller"],
  options: RenderTuiOptions = {},
): Instance {
  return render(
    <TuiApp
      controller={controller}
      {...(options.title === undefined ? {} : { title: options.title })}
      {...(options.onError === undefined ? {} : { onError: options.onError })}
    />,
  );
}

