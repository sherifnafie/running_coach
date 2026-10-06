import { ToolInputs, type ToolDef } from '@opencoach/protocol';
import { IMAGE_EXTS, extOf, fail, guard, imagePart, isProbablyBinary, ok, truncateMiddle } from './util';

const MAX_LINE = 2000;

export const readTool: ToolDef<'read'> = {
  name: 'read',
  description:
    'Read a file or list a directory. Paths are virtual: /workspace (yours, read-write), /raw (athlete uploads, read-only), ' +
    '/history (rendered daily transcripts and call transcripts, read-only), /system (constitution, docs, skills, read-only). ' +
    'Relative paths resolve under /workspace. Text files come back with line numbers (use offset/limit for long files). ' +
    'Images are returned so you can look at them (if your model has vision).',
  input: ToolInputs.read,
  availableTo: ['coach', 'helper'],
  execute: (input, ctx) =>
    guard(async () => {
      const st = await ctx.fs.stat(input.path);
      if (!st) return fail('ENOENT', `No such file or directory: ${input.path}`);
      const resolved = ctx.fs.resolve(input.path, 'read');
      if (st.isDir) {
        const base = resolved.virtual.replace(/\/+$/, '');
        const files = await ctx.fs.glob('*', base);
        const nested = await ctx.fs.glob('*/**', base).catch(() => [] as string[]);
        const names = new Set<string>();
        for (const f of files) names.add(f.slice(base.length + 1));
        for (const f of nested) {
          const first = f.slice(base.length + 1).split('/')[0];
          if (first) names.add(`${first}/`);
        }
        const lines = [...names].sort();
        return ok(`Directory ${base} (${lines.length} entries; empty subdirectories are not shown):\n${lines.join('\n') || '(empty)'}`);
      }
      const ext = extOf(resolved.virtual);
      const mime = IMAGE_EXTS[ext];
      if (mime) {
        if (!ctx.vision) {
          return ok(
            `${resolved.virtual} is an image (${mime}, ${Math.round(st.size / 1024)} KB). Your current model cannot view images: ` +
              `delegate to a helper with vision, e.g. spawn_agent({ profile: "extractor", inputs: ["${resolved.virtual}"], task: "…" }).`,
          );
        }
        const data = await ctx.fs.readFile(resolved.virtual);
        const part = await imagePart(ctx, data, mime, resolved.virtual);
        if (!part) return fail('INVALID_INPUT', `Could not decode image ${resolved.virtual} (${mime}). Try converting it with bash first.`);
        return ok(`Image ${resolved.virtual} (${mime}, ${Math.round(st.size / 1024)} KB):`, [part]);
      }
      if (ext === '.pdf') {
        return ok(`${resolved.virtual} is a PDF (${Math.round(st.size / 1024)} KB). Extract text with bash, e.g. python3 with pypdf if available, or ask the athlete for a screenshot.`);
      }
      const data = await ctx.fs.readFile(resolved.virtual);
      if (isProbablyBinary(data)) {
        return ok(`${resolved.virtual} is a binary file (${st.size} bytes, extension "${ext || 'none'}"). Use bash (python3) to parse it.`);
      }
      const text = Buffer.from(data).toString('utf8');
      const all = text.split('\n');
      const offset = input.offset ?? 0;
      const limit = input.limit ?? 2000;
      const slice = all.slice(offset, offset + limit);
      const width = String(offset + slice.length).length;
      const body = slice
        .map((l, i) => `${String(offset + i + 1).padStart(width, ' ')}\t${l.length > MAX_LINE ? `${l.slice(0, MAX_LINE)}… [line truncated]` : l}`)
        .join('\n');
      const more = offset + slice.length < all.length ? `\n[… ${all.length - offset - slice.length} more lines; use offset=${offset + slice.length}]` : '';
      return ok(`${resolved.virtual} (${all.length} lines):\n${body}${more}`);
    }),
};

export const writeTool: ToolDef<'write'> = {
  name: 'write',
  description:
    'Create or overwrite a file in /workspace (parent directories are created). Use edit for small changes to existing files. ' +
    'Your changes are committed automatically at the end of the turn.',
  input: ToolInputs.write,
  availableTo: ['coach', 'helper'],
  execute: (input, ctx) =>
    guard(async () => {
      const r = ctx.fs.resolve(input.path, 'write');
      await ctx.fs.writeFile(r.virtual, input.content);
      return ok(`Wrote ${Buffer.byteLength(input.content, 'utf8')} bytes to ${r.virtual}.`);
    }),
};

export const editTool: ToolDef<'edit'> = {
  name: 'edit',
  description:
    'Replace exact text in a /workspace file. `old` must match exactly once (including whitespace) unless replace_all is true. ' +
    'Read the file first so the match is exact.',
  input: ToolInputs.edit,
  availableTo: ['coach', 'helper'],
  execute: (input, ctx) =>
    guard(async () => {
      const r = ctx.fs.resolve(input.path, 'write');
      const st = await ctx.fs.stat(r.virtual);
      if (!st) return fail('ENOENT', `No such file: ${r.virtual}. Use write to create it.`);
      const text = await ctx.fs.readText(r.virtual);
      const count = text.split(input.old).length - 1;
      if (count === 0) return fail('NOT_FOUND', `The text to replace was not found in ${r.virtual}. Read the file and copy the exact text.`);
      if (count > 1 && !input.replace_all) {
        return fail('NOT_UNIQUE', `The text occurs ${count} times in ${r.virtual}. Include more surrounding context or set replace_all: true.`);
      }
      const next = input.replace_all ? text.split(input.old).join(input.new) : text.replace(input.old, () => input.new);
      await ctx.fs.writeFile(r.virtual, next);
      return ok(`Edited ${r.virtual} (${input.replace_all ? count : 1} replacement${(input.replace_all ? count : 1) === 1 ? '' : 's'}).`);
    }),
};

export const globTool: ToolDef<'glob'> = {
  name: 'glob',
  description: 'Find files by glob pattern (e.g. "journal/**/*.md", "*.png"). Base defaults to /workspace; can be /raw, /history or /system.',
  input: ToolInputs.glob,
  availableTo: ['coach', 'helper'],
  execute: (input, ctx) =>
    guard(async () => {
      const files = await ctx.fs.glob(input.pattern, input.path);
      if (files.length === 0) return ok(`No files match ${input.pattern}${input.path ? ` under ${input.path}` : ''}.`);
      const shown = files.slice(0, 500);
      return ok(`${files.length} match${files.length === 1 ? '' : 'es'}:\n${shown.join('\n')}${files.length > shown.length ? `\n[… ${files.length - shown.length} more]` : ''}`);
    }),
};

export const grepTool: ToolDef<'grep'> = {
  name: 'grep',
  description: 'Search file contents with a JavaScript regular expression. Optional path (default /workspace), file glob filter, context lines and max matches.',
  input: ToolInputs.grep,
  availableTo: ['coach', 'helper'],
  execute: (input, ctx) =>
    guard(async () => {
      let re: RegExp;
      try {
        re = new RegExp(input.pattern, input.case_insensitive ? 'i' : '');
      } catch (e) {
        return fail('INVALID_INPUT', `Invalid regular expression: ${(e as Error).message}`);
      }
      void re;
      const matches = await ctx.fs.grep({
        pattern: input.pattern,
        path: input.path,
        glob: input.glob,
        context: input.context,
        max: input.max ?? 100,
        caseInsensitive: input.case_insensitive,
      });
      if (matches.length === 0) return ok('No matches.');
      const lines: string[] = [];
      for (const m of matches) {
        if (m.context?.before.length) for (const [i, b] of m.context.before.entries()) lines.push(`${m.path}:${m.line - m.context.before.length + i}- ${b}`);
        lines.push(`${m.path}:${m.line}: ${m.text}`);
        if (m.context?.after.length) for (const [i, a] of m.context.after.entries()) lines.push(`${m.path}:${m.line + i + 1}- ${a}`);
      }
      return ok(truncateMiddle(`${matches.length} match${matches.length === 1 ? '' : 'es'}:\n${lines.join('\n')}`, 40_000));
    }),
};

export const bashTool: ToolDef<'bash'> = {
  name: 'bash',
  description:
    'Run a shell command in your sandbox (bash). Working directory defaults to /workspace. Available: python3 (pandas, numpy and more), ' +
    'node, git, ffmpeg and standard Unix tools. There is NO network access and no credentials. Query your database with python3 ' +
    '(import sqlite3; sqlite3.connect("data/coach.db")). Output is truncated if very long. Default timeout 120 s (max 300).',
  input: ToolInputs.bash,
  availableTo: ['coach', 'helper'],
  execute: (input, ctx) =>
    guard(async () => {
      const r = await ctx.sandbox.exec(input.command, { timeoutS: input.timeout_s ?? 120, cwd: input.cwd, signal: ctx.signal });
      const parts: string[] = [];
      parts.push(r.timedOut ? `Timed out after ${input.timeout_s ?? 120}s (killed).` : `Exit code ${r.exitCode} (${(r.durationMs / 1000).toFixed(1)}s).`);
      if (r.stdout) parts.push(`stdout:\n${truncateMiddle(r.stdout, 30_000)}`);
      if (r.stderr) parts.push(`stderr:\n${truncateMiddle(r.stderr, 10_000)}`);
      if (!r.stdout && !r.stderr) parts.push('(no output)');
      if (r.truncated) parts.push('[output was truncated by the sandbox]');
      const text = parts.join('\n');
      if (r.timedOut) return fail('TIMEOUT', text);
      return ok(text);
    }),
};
