// インストール済みの Chrome / Edge を探す (環境変数 CHROME_PATH が最優先)、全画面で起動する
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/microsoft-edge',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

export function findBrowser() {
  return [process.env.CHROME_PATH, ...CANDIDATES].filter(Boolean).find((p) => fs.existsSync(p)) || null;
}

/** 発表用プロファイル (普段の Chrome と別プロセスで起動するため。既に起動中の Chrome は全画面の指定を無視する) */
export const PRESENT_PROFILE = path.join(os.tmpdir(), 'jh-presentation-browser');

/**
 * 全画面で開くための起動引数。
 * --app でタブ・アドレスバーのないウィンドウにし、--start-fullscreen で全画面にする (F11 / Esc で解除できる)。
 * キオスクモード (--kiosk) は抜けにくいので使わない。
 */
export function fullscreenArgs(url, profile = PRESENT_PROFILE) {
  return [
    `--app=${url}`,
    '--start-fullscreen',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
  ];
}

/** Chrome / Edge を全画面で起動する。ブラウザが見つからなければ false */
export function launchFullscreen(url) {
  const browser = findBrowser();
  if (!browser) return false;
  fs.mkdirSync(PRESENT_PROFILE, { recursive: true });
  spawn(browser, fullscreenArgs(url), { detached: true, stdio: 'ignore' }).unref();
  return true;
}
