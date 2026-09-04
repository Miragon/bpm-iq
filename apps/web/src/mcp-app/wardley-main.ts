/** the wardley map widget — the Miragon engine on the shared widget core; no
 *  extras, no icon font, the file-route deep link (core/widget.ts defaults) */
import "./wardley-styles.css";

import { bootWidget } from "./core/widget";
import { mountWardleyEngine } from "./engines/wardley";

bootWidget({ notation: "wardley", noun: "wardley map", engine: mountWardleyEngine });
