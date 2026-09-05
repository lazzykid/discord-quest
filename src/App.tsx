import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

type ProcessInfo = {
  pid: number;
  name: string;
  exePath: string;
  startedAt: number;
  accumulated: number;
};

type StashedSession = {
  name: string;
  exePath: string;
  accumulated: number;
};

type FarmState = {
  totals: { sec: number; runs: number };
  stash: StashedSession[];
};

type DiscordExecutable = {
  name?: string;
  os?: string;
  is_launcher?: boolean;
};

type DiscordApp = {
  id: string;
  name: string;
  aliases?: string[];
  icon_hash?: string | null;
  icon?: string | null;
  executables?: DiscordExecutable[];
};

type GameRow = {
  id: string;
  name: string;
  exeName: string;
  iconUrl: string | null;
  searchText: string;
};

const QUEST_TARGET_SEC = 15 * 60;
const PIN_KEY = "dq.pinned";

function TitleBar({ catalogState }: { catalogState: string }) {
  const win = getCurrentWindow();

  return (
    <header className="titlebar" data-tauri-drag-region>
      <div className="titlebar-left" data-tauri-drag-region>
        <svg className="mark" viewBox="0 0 20 20" aria-hidden="true">
          <path d="M11.5 1 3 11.5h5L8.5 19 17 8.5h-5z" />
        </svg>
        <span className="wordmark">
          QUEST<em>/rig</em>
        </span>
        <span className="tb-stat" data-tauri-drag-region>
          {catalogState}
        </span>
      </div>
      <div className="window-btns">
        <button type="button" className="wbtn" aria-label="Minimize" onClick={() => void win.minimize()}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3 8h10" />
          </svg>
        </button>
        <button type="button" className="wbtn close" aria-label="Close" onClick={() => void win.close()}>
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4 4l8 8M12 4L4 12" />
          </svg>
        </button>
      </div>
    </header>
  );
}

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function formatClock(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

function formatTotal(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h > 0) return `${h}h ${pad(m)}m`;
  return `${m}m`;
}

function win32Exe(app: DiscordApp): string | null {
  const list = app.executables ?? [];
  const windows = list.filter((exe) => (exe.os ?? "").toLowerCase() === "win32" && exe.name);
  const preferred = windows.find((exe) => !exe.is_launcher) ?? windows[0] ?? null;
  return preferred?.name?.trim() || null;
}

function iconUrl(app: DiscordApp): string | null {
  const hash = app.icon_hash || app.icon;
  if (!hash) return null;
  return `https://cdn.discordapp.com/app-icons/${app.id}/${hash}.png?size=512`;
}

function toGameRow(app: DiscordApp): GameRow | null {
  const exeName = win32Exe(app);
  if (!exeName) return null;
  return {
    id: app.id,
    name: app.name,
    exeName,
    iconUrl: iconUrl(app),
    searchText: `${app.name} ${(app.aliases ?? []).join(" ")} ${exeName}`.toLowerCase(),
  };
}

function QuestBar({ elapsed }: { elapsed: number }) {
  const pct = Math.min(100, (elapsed / QUEST_TARGET_SEC) * 100);
  const done = elapsed >= QUEST_TARGET_SEC;
  return (
    <div className={`qbar ${done ? "done" : ""}`}>
      <div className="qbar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export default function App() {
  const [games, setGames] = useState<GameRow[]>([]);
  const [query, setQuery] = useState("");
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [loadingGames, setLoadingGames] = useState(true);
  const [catalogSource, setCatalogSource] = useState<"live" | "cache" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [farm, setFarm] = useState<FarmState>({ totals: { sec: 0, runs: 0 }, stash: [] });
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [nowSec, setNowSec] = useState(Math.floor(Date.now() / 1000));
  const [pinned, setPinned] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(PIN_KEY) ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  const [helpOpen, setHelpOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const notify = (kind: "ok" | "err", text: string) => {
    setToast({ kind, text });
    window.setTimeout(() => setToast(null), 3200);
  };

  const togglePin = (id: string) => {
    setPinned((prev) => {
      const next = prev.includes(id) ? prev.filter((p) => p !== id) : [id, ...prev];
      localStorage.setItem(PIN_KEY, JSON.stringify(next));
      return next;
    });
  };

  const refreshProcesses = useCallback(async () => {
    try {
      setProcesses(await invoke<ProcessInfo[]>("list_processes"));
      setFarm(await invoke<FarmState>("get_farm_state"));
    } catch {
      /* ignore */
    }
  }, []);

  const loadGames = useCallback(async () => {
    setLoadingGames(true);
    setLoadError(null);
    setCatalogSource(null);
    try {
      let raw: DiscordApp[] | null = null;
      try {
        const res = await fetch("https://discord.com/api/v9/applications/detectable");
        if (res.ok) {
          raw = (await res.json()) as DiscordApp[];
          setCatalogSource("live");
        }
      } catch {
        raw = null;
      }
      if (!raw) {
        raw = await invoke<DiscordApp[]>("get_detectable_games");
        setCatalogSource("cache");
      }
      const mapped = raw
        .map(toGameRow)
        .filter((row): row is GameRow => row !== null)
        .sort((a, b) => a.name.localeCompare(b.name, "en"));
      setGames(mapped);
    } catch (e) {
      setLoadError(typeof e === "string" ? e : String(e));
    } finally {
      setLoadingGames(false);
    }
  }, []);

  useEffect(() => {
    void loadGames();
  }, [loadGames]);

  useEffect(() => {
    void refreshProcesses();
    const t = window.setInterval(() => {
      void refreshProcesses();
      setNowSec(Math.floor(Date.now() / 1000));
    }, 1000);
    return () => window.clearInterval(t);
  }, [refreshProcesses]);

  const ordered = useMemo(() => {
    const rank = new Map(pinned.map((id, i) => [id, i]));
    return [...games].sort((a, b) => {
      const ra = rank.get(a.id);
      const rb = rank.get(b.id);
      if (ra !== undefined || rb !== undefined) return (ra ?? 1e9) - (rb ?? 1e9);
      return a.name.localeCompare(b.name, "en");
    });
  }, [games, pinned]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const base = q
      ? ordered.filter((g) => g.searchText.includes(q))
      : ordered;
    return base.slice(0, 200);
  }, [ordered, query]);

  useEffect(() => {
    setSelectedIdx(0);
  }, [query]);

  const selected = filtered[Math.min(selectedIdx, Math.max(0, filtered.length - 1))] ?? null;

  const catalogState = loadingGames
    ? "SYNCING CATALOG…"
    : loadError
      ? "CATALOG OFFLINE"
      : catalogSource === "live"
        ? `CATALOG ${games.length.toLocaleString("en-US")} · LIVE`
        : `CATALOG ${games.length.toLocaleString("en-US")} · CACHE`;

  // backend reports full paths, catalog has bare names — match on file name
  const exeKey = (p: string) => p.split(/[\\/]/).pop()?.toLowerCase() ?? p.toLowerCase();

  const runningExes = useMemo(
    () => new Set(processes.map((p) => exeKey(p.exePath))),
    [processes],
  );

  const startGame = async (game: GameRow) => {
    if (busyId) return;
    if (runningExes.has(exeKey(game.exeName))) {
      notify("err", `${game.name} is already running`);
      return;
    }
    setBusyId(game.id);
    try {
      const pid = await invoke<number>("start_dummy_process", {
        exeName: game.exeName,
        gameName: game.name,
      });
      setProcesses((prev) => [
        {
          pid,
          name: game.name,
          exePath: game.exeName,
          startedAt: Math.floor(Date.now() / 1000),
          accumulated: 0,
        },
        ...prev.filter((p) => p.pid !== pid),
      ]);
      notify("ok", `${game.name} — PID ${pid} · the client picks it up in ~30s`);
      void refreshProcesses();
    } catch (e) {
      notify("err", typeof e === "string" ? e : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const stopProcess = async (pid: number) => {
    if (busyId) return;
    setBusyId(`pid-${pid}`);
    try {
      await invoke("stop_dummy_process", { pid });
      setProcesses((prev) => prev.filter((p) => p.pid !== pid));
      notify("ok", `PID ${pid} stopped`);
    } catch (e) {
      notify("err", typeof e === "string" ? e : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const resumeStashed = async (exePath: string) => {
    if (busyId) return;
    setBusyId(`stash-${exePath}`);
    try {
      await invoke<number>("resume_stashed_process", { exePath });
      notify("ok", "resumed — the quest keeps ticking");
      void refreshProcesses();
    } catch (e) {
      notify("err", typeof e === "string" ? e : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const dropStashed = async (exePath: string) => {
    if (busyId) return;
    setBusyId(`stash-${exePath}`);
    try {
      await invoke("drop_stashed_process", { exePath });
      void refreshProcesses();
    } catch (e) {
      notify("err", typeof e === "string" ? e : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter" && selected) {
      e.preventDefault();
      void startGame(selected);
    } else if (e.key === "Escape") {
      setQuery("");
      (e.target as HTMLElement).blur();
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      if (e.key === "/") {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const totalRunSec = processes.reduce((acc, p) => acc + (nowSec - p.startedAt), 0);
  const questDoneCount = processes.filter((p) => nowSec - p.startedAt >= QUEST_TARGET_SEC).length;
  const isPinned = selected ? pinned.includes(selected.id) : false;
  const selectedRunning = selected ? runningExes.has(exeKey(selected.exeName)) : false;

  return (
    <div className="shell">
      <div className="frame">
        <div className="grid-bg" aria-hidden="true" />
        <TitleBar catalogState={catalogState} />

        <main className="body">
          {/* ── Library ─────────────────────────────── */}
          <section className="library">
            <div className="searchline">
              <span className="prompt">⌕</span>
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="search the catalog — press / to focus"
                spellCheck={false}
              />
              <kbd>{filtered.length}</kbd>
            </div>

            {loadError && (
              <button className="retry" type="button" onClick={() => void loadGames()}>
                ! CATALOG OFFLINE — RETRY
              </button>
            )}

            <div className="covers">
              {loadingGames &&
                Array.from({ length: 24 }).map((_, i) => (
                  <div key={i} className="cover skeleton" style={{ "--d": `${(i % 6) * 60}ms` } as React.CSSProperties} />
                ))}
              {!loadingGames &&
                filtered.map((game, i) => (
                  <button
                    key={`${game.id}-${game.exeName}`}
                    className={`cover ${selected?.id === game.id ? "on" : ""}`}
                    onClick={() => {
                      setSelectedIdx(i);
                    }}
                    onDoubleClick={() => void startGame(game)}
                  >
                    <span className="cover-frame">
                      {game.iconUrl ? (
                        <img src={game.iconUrl} alt="" loading="lazy" />
                      ) : (
                        <span className="cover-fallback">{game.name.slice(0, 2).toUpperCase()}</span>
                      )}
                    </span>
                    <span className="cover-meta">
                      <em>{game.name}</em>
                      {pinned.includes(game.id) && <b className="pin-flag">PIN</b>}
                    </span>
                  </button>
                ))}
              {!loadingGames && filtered.length === 0 && (
                <p className="empty">nothing found for “{query}”</p>
              )}
            </div>
          </section>

          {/* ── Detail / control panel ──────────────── */}
          <aside className="panel">
            <div className="panel-scroll">
              {selected ? (
                <div className="spotlight">
                  <div className="spot-head">
                    <span className="spot-frame">
                      {selected.iconUrl ? (
                        <img src={selected.iconUrl} alt="" />
                      ) : (
                        <span className="cover-fallback big">
                          {selected.name.slice(0, 2).toUpperCase()}
                        </span>
                      )}
                    </span>
                    <button
                      className={`pin-btn ${isPinned ? "on" : ""}`}
                      title="Pin"
                      onClick={() => togglePin(selected.id)}
                    >
                      {isPinned ? "UNPIN" : "PIN"}
                    </button>
                  </div>
                  <h1 title={selected.name}>{selected.name}</h1>
                  <p className="exe">{selected.exeName}</p>
                  <button
                    className={`launch ${selectedRunning ? "live" : ""}`}
                    disabled={busyId !== null || selectedRunning}
                    onClick={() => void startGame(selected)}
                  >
                    {busyId === selected.id
                      ? "…"
                      : selectedRunning
                        ? "● LIVE"
                        : "▶ LAUNCH FAKE"}
                  </button>
                  <p className="hint">
                    the process lives as an off-screen window; the client picks the game up within ~30s
                  </p>
                </div>
              ) : (
                <div className="spotlight">
                  <h1 className="idle">{loadingGames ? "SYNC…" : "—"}</h1>
                </div>
              )}

              <div className="divider" />

              <div className="signals">
                <div className="signals-head">
                  <span className="label">SIGNALS</span>
                  <span className="label dim">
                    {processes.length > 0
                      ? `${processes.length} LIVE · ${formatTotal(totalRunSec)}${questDoneCount ? ` · ${questDoneCount} QUEST ✓` : ""}`
                      : "IDLE"}
                  </span>
                </div>

                <p className="totals">
                  ALL-TIME {formatTotal(farm.totals.sec)} · {farm.totals.runs}{" "}
                  {farm.totals.runs === 1 ? "RUN" : "RUNS"}
                </p>

                {processes.length === 0 ? (
                  <p className="signals-empty">
                    nothing running.<br />launch a fake — the quest ticks for 15 minutes.
                  </p>
                ) : (
                  <ul>
                    {processes.map((p) => {
                      const elapsed =
                        Math.max(0, nowSec - p.startedAt) + (p.accumulated || 0);
                      const done = elapsed >= QUEST_TARGET_SEC;
                      return (
                        <li key={p.pid}>
                          <div className="sess-top">
                            <span className={`dot ${done ? "done" : ""}`} />
                            <strong title={p.name}>{p.name}</strong>
                            <span className="sess-clock">{formatClock(elapsed)}</span>
                            <button
                              className="stop"
                              disabled={busyId !== null}
                              onClick={() => void stopProcess(p.pid)}
                              aria-label="Stop"
                            >
                              ✕
                            </button>
                          </div>
                          <div className="sess-bottom">
                            <QuestBar elapsed={elapsed} />
                            <span className={`sess-status ${done ? "ok" : ""}`}>
                              {done ? "QUEST ✓" : `QUEST ${formatClock(QUEST_TARGET_SEC - elapsed)}`}
                            </span>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>

              {farm.stash.length > 0 && (
                <>
                  <div className="divider" />
                  <div className="signals-head">
                    <span className="label">STASH</span>
                    <span className="label dim">PAUSED · RESUME WHERE IT STOPPED</span>
                  </div>
                  <ul className="stash-list">
                    {farm.stash.map((s) => (
                      <li key={s.exePath}>
                        <div className="sess-top">
                          <span className="dot paused" />
                          <strong title={s.name}>{s.name}</strong>
                          <span className="sess-clock">{formatClock(s.accumulated)}</span>
                          <button
                            className="stop"
                            disabled={busyId !== null}
                            onClick={() => void dropStashed(s.exePath)}
                            aria-label="Dismiss"
                          >
                            ✕
                          </button>
                        </div>
                        <div className="sess-bottom">
                          <span className="sess-status">
                            BANKED {formatClock(s.accumulated)} / 15:00
                          </span>
                          <button
                            className="resume"
                            disabled={busyId !== null}
                            onClick={() => void resumeStashed(s.exePath)}
                          >
                            ▶ RESUME
                          </button>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <div className="divider" />

              <button className="help-toggle" type="button" onClick={() => setHelpOpen((v) => !v)}>
                {helpOpen ? "−" : "+"} DISCORD DOESN'T SEE THE GAME?
              </button>
              {helpOpen && (
                <ol className="help">
                  <li>
                    Discord → Settings → <b>Privacy Settings</b> → turn on “Share detected
                    activity”. Otherwise the detection is shown to no one — including you.
                  </li>
                  <li>
                    Check <b>Settings → Activity Status</b>: detected games appear there. Your
                    fake should be listed.
                  </li>
                  <li>
                    Detection is not instant: the scanner polls processes every ~15–30s. Give it
                    a minute.
                  </li>
                  <li>
                    “Play 15 minutes” quests only tick while the process stays alive — don’t stop
                    it early.
                  </li>
                  <li>
                    Achievement quests can’t be faked — they need real data from the game itself.
                  </li>
                </ol>
              )}
            </div>
          </aside>
        </main>

        {toast && <div className={`toast ${toast.kind}`}>{toast.text}</div>}
      </div>
    </div>
  );
}
