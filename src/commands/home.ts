/**
 * The view with no arguments: live content, not a manual — the newest
 * documents, the size of the corpus, and the commands that follow. It is also
 * what a session-start hook prints, so it is small, and it never fails: with
 * no sign-in or no network it still says what the tool is and what to run.
 */
import { apiGet, offersObligations, serverRoutes } from "../api.js";
import { authState } from "../auth.js";
import { CliError } from "../errors.js";
import { compose, cut, helpBlock, run, toon, type Block } from "../output.js";

const NEWEST = 5;

interface Recent {
  total: number;
  documents: Array<{ uid: string; title: string; published: string | null; regulator: string | null }>;
}
interface Regions {
  regulators: number;
  jurisdictions: number;
  documents: number;
}

export async function homeCommand(): Promise<string> {
  const state = authState();
  if (state.state === "signed_out" || state.state === "pending") {
    return compose(
      toon({
        account: state.state === "pending" ? "a sign-in waits for the approval in a browser" : "not signed in",
        ...(state.state === "pending" ? { url: state.url } : {}),
      }),
      helpBlock([
        state.state === "pending" ? "Open the url in a browser, sign in to RegAlert and approve" : run("auth login", "to sign in (free with a RegAlert account)"),
        run("--help", "for the commands"),
      ]),
    );
  }

  let live: Block;
  let obligations = false;
  try {
    const [recent, regions, routes] = await Promise.all([
      apiGet<Recent>("/v1/recent", { limit: NEWEST, fields: "uid,title,published,regulator" }),
      apiGet<Regions>("/v1/regulators"),
      serverRoutes(),
    ]);
    obligations = offersObligations(routes);
    live = {
      corpus: `${regions.documents} documents, ${regions.regulators} regulators, ${regions.jurisdictions} jurisdictions`,
      newest: recent.documents.map((d) => ({ ...d, title: cut(d.title, 90) })),
    };
  } catch (err) {
    // The home view opens every hooked session: a server that is down must not turn that into an error.
    const e = err instanceof CliError ? err : new CliError((err as Error).message, "UNKNOWN");
    return compose(toon({ account: "signed in", live: `not available (${e.message})` }), helpBlock([...e.suggestions.slice(0, 1), run("--help", "for the commands")]));
  }

  return compose(
    toon(live),
    helpBlock([
      run('search "<words>" [--regulator <code>] [--jurisdiction <code>] [--topic <topic>]', "to search the documents"),
      run("recent --regulator <code> --since <YYYY-MM-DD>", "for what was published, newest first"),
      run('doc <uid> --query "<words>"', "to read only the matching passages of one document"),
      obligations ? run('obligations "<a duty in plain words>"', "to find the rule sentences by meaning") : "",
      run("regulators", "and `regalert-axi topics` for the codes the filters take"),
    ]),
  );
}
