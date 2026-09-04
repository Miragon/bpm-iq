/** the team topology widget — the Miragon engine on the shared widget core; no
 *  extras, no icon font, the file-route deep link (core/widget.ts defaults) */
import "./team-topology-styles.css";

import { bootWidget } from "./core/widget";
import { mountTeamTopologyEngine } from "./engines/team-topology";

bootWidget({ notation: "team-topology", noun: "team topology", engine: mountTeamTopologyEngine });
