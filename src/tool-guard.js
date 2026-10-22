/**
 * Which tools a web-backed session may use.
 *
 * This module exists on its own because the policy is a security boundary, not an
 * implementation detail: it is the one place that answers "can a conversation
 * running on the web endpoint touch this machine". Keeping it separate makes the
 * whitelist reviewable on its own and testable without a plugin host.
 *
 * @module src/tool-guard
 */

/**
 * Tools a web-backed session is allowed to use.
 *
 * This is a WHITELIST, not a blocklist. The promise this plugin makes is "a web
 * conversation never writes to the local disk", and a blocklist cannot keep that
 * promise: it silently stops protecting the moment a composition adds a tool the
 * list predates. An earlier blocklist here missed `pwsh` (arbitrary shell) and
 * `plugin_manager` (installs code) — exactly the failure mode.
 *
 * A web conversation is not expected to call tools at all (the web endpoint has no
 * function-calling channel), so denying an unrecognized tool costs nothing while
 * keeping the promise closed under new tools.
 */
export const READ_ONLY_TOOLS = new Set([
  // Filesystem reads
  'read',
  'glob',
  'grep',
  'read_image',
  'working_directory',
  'load_workspace_dependencies',
  // Network reads
  'web_search',
  'web_fetch',
  // Harness introspection
  'cordis_inspect_list',
  'cordis_inspect_query',
  'skill',
  'todo_write',
  'ask_user_question',
  // Background-job inspection (jobs are started by a tool that is itself denied)
  'job_output',
  'job_list',
  'job_kill',
  // Team visibility
  'list_agents',
  'send_message',
  'wait_agent',
  // Declares existing files as deliverables; writes nothing
  'present',
]);

/**
 * Whether a web-backed session may run this tool.
 *
 * Unknown names are denied: the promise is about what CANNOT happen, so silence
 * about a tool has to mean "no", not "sure".
 *
 * @param {unknown} name
 * @returns {boolean}
 */
export function isToolAllowedInWebSession(name) {
  return typeof name === 'string' && READ_ONLY_TOOLS.has(name);
}

/**
 * The rejection message shown when a tool is refused inside a web session.
 *
 * @param {unknown} name
 * @returns {string}
 */
export function toolRejectionMessage(name) {
  return `deepseek-web: 「${String(name)}」可能在本地产生副作用，网页版对话只允许只读操作`;
}
