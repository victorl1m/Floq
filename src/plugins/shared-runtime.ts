import * as React from "react";
import * as jsx from "react/jsx-runtime";
import * as kit from "@/plugins/kit";
import * as sdk from "@/plugins/sdk";
import { installSharedRuntime } from "./remote-ui";

/** Imported once at startup (main.tsx) before any remote plugin UI loads: bundles take React, the kit and the SDK from this global. */
installSharedRuntime({ react: React, jsx, kit, sdk });
