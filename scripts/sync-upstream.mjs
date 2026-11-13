#!/usr/bin/env node
//
// 把上游 Clash Party 的最新提交合并进本仓库的服务化分支。
//
// 默认是预演（dry-run）：只报告会发生什么，结束后把工作区恢复原状。
// 传 --apply 才会真正生成合并提交；有冲突时改为把合并结果写到
// --conflict-branch 指定的分支，交给 Pull Request 走人工解决。
//
// 用法：
//   node scripts/sync-upstream.mjs                                   # 预演
//   node scripts/sync-upstream.mjs --apply                           # 真的合并
//   node scripts/sync-upstream.mjs --upstream-branch=main --apply    # 换上游分支
//
// 约定：
//   - 冲突文件命中 .github/sync/keep-local.txt 时保留本地版本；
//   - pnpm-lock.yaml 冲突时取上游版本，再用 pnpm 重新生成；
//   - 其余冲突不猜，交给人工。
//
// 退出码：0 = 正常（含「上游没有新提交」与「有冲突待人工」），1 = 流程出错。

import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const keepLocalFile = join(root, '.github/sync/keep-local.txt')
const lockFile = 'pnpm-lock.yaml'
const reportDir = process.env.RUNNER_TEMP || tmpdir()
const isWindows = process.platform === 'win32'

function parseArgs(argv) {
  const options = {
    upstreamRepo: 'mihomo-party-org/clash-party',
    upstreamBranch: 'smart_core',
    conflictBranch: 'sync/upstream',
    apply: false,
    refreshLock: true
  }

  for (const arg of argv) {
    if (arg === '--apply') {
      options.apply = true
    } else if (arg === '--dry-run') {
      options.apply = false
    } else if (arg === '--no-lock-refresh') {
      options.refreshLock = false
    } else if (arg.startsWith('--upstream-repo=')) {
      options.upstreamRepo = arg.slice('--upstream-repo='.length)
    } else if (arg.startsWith('--upstream-branch=')) {
      options.upstreamBranch = arg.slice('--upstream-branch='.length)
    } else if (arg.startsWith('--conflict-branch=')) {
      options.conflictBranch = arg.slice('--conflict-branch='.length)
    } else {
      throw new Error(`未知参数：${arg}`)
    }
  }

  return options
}

// 预演模式下工作区只做临时合并再回滚，不需要真实的提交身份。
let identityArgs = []

function run(command, args, { allowFailure = false, timeout = 15 * 60 * 1000 } = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    timeout,
    shell: isWindows && command.endsWith('.cmd'),
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })

  if (result.error) {
    throw result.error
  }

  const output = {
    status: result.status,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim()
  }

  if (output.status !== 0 && !allowFailure) {
    const detail = [output.stdout, output.stderr].filter(Boolean).join('\n')
    throw new Error(`命令失败：${command} ${args.join(' ')}\n${detail}`)
  }

  return output
}

function git(args, options) {
  return run('git', [...identityArgs, ...args], options)
}

function configureIdentity(options) {
  const email = git(['config', 'user.email'], { allowFailure: true }).stdout
  const name = git(['config', 'user.name'], { allowFailure: true }).stdout

  if (email && name) {
    return
  }

  if (options.apply) {
    throw new Error('缺少 git 提交身份，先设置 user.name 与 user.email（CI 里由 workflow 注入）')
  }

  identityArgs = ['-c', 'user.name=sync-upstream', '-c', 'user.email=sync-upstream@localhost']
  console.warn('提示：本地未配置 git 身份，预演使用临时身份，不会产生提交。')
}

function listConflicted() {
  const output = git(['diff', '--name-only', '--diff-filter=U']).stdout
  return output
    ? output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    : []
}

function isMerging() {
  const result = git(['rev-parse', '--verify', '--quiet', 'MERGE_HEAD'], { allowFailure: true })
  return result.status === 0
}

function abortMerge() {
  if (isMerging()) {
    git(['merge', '--abort'], { allowFailure: true })
  }
}

function ensureCleanWorktree() {
  // 未跟踪文件不会参与合并（除非上游新增同名文件，git 会自己拒绝），
  // 所以只拦已跟踪文件的改动，避免把 WIP 卷进同步提交。
  const dirty = git(['status', '--porcelain', '--untracked-files=no']).stdout
  if (dirty) {
    throw new Error(
      `工作区有未提交的改动，先处理干净再同步：\n${dirty.split('\n').slice(0, 10).join('\n')}`
    )
  }
}

function loadKeepLocalPatterns() {
  if (!existsSync(keepLocalFile)) {
    return []
  }

  return readFileSync(keepLocalFile, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map(globToRegExp)
}

function globToRegExp(pattern) {
  let source = '^'

  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]

    if (char === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*'
        index++
      } else {
        source += '[^/]*'
      }
    } else if (char === '?') {
      source += '[^/]'
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }

  return new RegExp(`${source}$`)
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

function fetchUpstream(options) {
  const url = `https://github.com/${options.upstreamRepo}.git`
  const ref = `refs/remotes/upstream/${options.upstreamBranch}`
  // GitHub 的连通性时好时坏，偶发的 TLS/连接重置不值得让整次同步失败。
  const attempts = 4
  let lastError = ''

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = git(
      ['fetch', '--no-tags', '--prune', url, `+refs/heads/${options.upstreamBranch}:${ref}`],
      { allowFailure: true }
    )

    if (result.status === 0) {
      const resolved = git(['rev-parse', '--verify', `upstream/${options.upstreamBranch}`])
      if (resolved.stdout) {
        return `upstream/${options.upstreamBranch}`
      }
    }

    lastError = result.stderr || result.stdout
    console.warn(`拉取上游失败（第 ${attempt}/${attempts} 次）：${lastError.split('\n')[0]}`)

    if (attempt < attempts) {
      sleepSync(5000 * attempt)
    }
  }

  throw new Error(`取不到上游分支 ${options.upstreamRepo}@${options.upstreamBranch}\n${lastError}`)
}

function countCommits(range) {
  const count = Number(git(['rev-list', '--count', range]).stdout)
  return Number.isFinite(count) ? count : 0
}

function listSubjects(range, limit = 40) {
  const output = git(['log', '--no-merges', '--format=- %h %s', `-n${limit}`, range]).stdout
  return output ? output.split('\n') : []
}

function readVersion() {
  try {
    return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version || ''
  } catch {
    return ''
  }
}

function refreshLockfile() {
  const command = isWindows ? 'pnpm.cmd' : 'pnpm'
  const result = run(command, ['install', '--lockfile-only', '--ignore-scripts'], {
    allowFailure: true
  })

  if (result.status !== 0) {
    console.warn('pnpm 重新生成 pnpm-lock.yaml 失败：')
    console.warn(result.stderr || result.stdout)
    return false
  }

  git(['add', '--', lockFile])
  return true
}

// 冲突文件分三类：保留本地、重新生成、交给人工。
// pnpm-lock.yaml 永远取上游版本再重新生成，冲突标记留在锁文件里没法用。
function resolveConflicts(conflicted, patterns, options) {
  const autoResolved = []
  const unresolved = []
  let needsLockRefresh = false

  for (const file of conflicted) {
    if (file === lockFile) {
      git(['checkout', '--theirs', '--', file])
      git(['add', '--', file])
      autoResolved.push({ file, reason: 'take-upstream' })
      needsLockRefresh = Boolean(options.refreshLock)
      continue
    }

    if (patterns.some((pattern) => pattern.test(file))) {
      git(['checkout', '--ours', '--', file])
      git(['add', '--', file])
      autoResolved.push({ file, reason: 'keep-local' })
      continue
    }

    unresolved.push(file)
  }

  return { autoResolved, unresolved, needsLockRefresh }
}

function writeMergeMessage(options, upstreamSha, subjects) {
  const lines = [
    `chore(sync): 同步上游 ${options.upstreamRepo}@${upstreamSha.slice(0, 7)}（${subjects.length} 个提交）`,
    '',
    ...subjects
  ]

  const messageFile = join(reportDir, 'sync-upstream-merge-message.txt')
  writeFileSync(messageFile, `${lines.join('\n')}\n`, 'utf8')
  return messageFile
}

function commitMerge(messageFile) {
  git(['commit', '--file', messageFile])
  return git(['rev-parse', '--short', 'HEAD']).stdout
}

function createConflictBranch(options, ref, messageFile, patterns) {
  git(['merge', '--abort'], { allowFailure: true })
  git(['checkout', '--force', '-B', options.conflictBranch])

  const merge = git(['merge', '--no-commit', '--no-ff', ref], { allowFailure: true })
  const conflicted = listConflicted()

  if (merge.status !== 0 && conflicted.length === 0) {
    throw new Error('重建冲突分支时合并失败，但没有识别到冲突文件')
  }

  if (conflicted.length > 0) {
    resolveConflicts(conflicted, patterns, { ...options, refreshLock: false })
    git(['add', '--', ...conflicted])
  }

  // 只提交合并带进来的改动：--update 不会把本地未跟踪的新文件卷进这次同步。
  // 冲突标记原样提交，Pull Request 会以草稿形式打开，避免误合并。
  git(['add', '--update'])
  return commitMerge(messageFile)
}

function writePullRequestBody(options, summary, subjects) {
  const hasConflicts = summary.unresolved.length > 0
  const lines = [
    `上游 \`${options.upstreamRepo}@${options.upstreamBranch}\` 有 **${summary.incomingCommits}** 个新提交，`,
    hasConflicts
      ? `自动合并到 \`${summary.targetBranch}\` 时在 **${summary.unresolved.length}** 个文件上产生了冲突。`
      : `已合并到 \`${summary.targetBranch}\` 的候选分支上，但合并后的检查没有通过。`,
    '',
    `- 上游最新提交：\`${summary.upstreamSha.slice(0, 7)}\``,
    hasConflicts
      ? '- 合并方式：`git merge --no-ff`，冲突标记已保留在这条分支上'
      : '- 合并方式：`git merge --no-ff`，在这条分支上补检查即可',
    ''
  ]

  if (hasConflicts) {
    lines.push(
      '## 需要人工解决的文件',
      '',
      ...summary.unresolved.map((file) => `- \`${file}\``),
      ''
    )
  }

  if (summary.autoResolved.length > 0) {
    lines.push('## 已自动处理', '')
    for (const item of summary.autoResolved) {
      const reason = item.reason === 'keep-local' ? '保留本地版本' : '取上游版本'
      lines.push(`- \`${item.file}\`（${reason}）`)
    }
    lines.push('')
  }

  if (summary.autoResolved.some((item) => item.file === lockFile)) {
    lines.push(
      '> `pnpm-lock.yaml` 取的是上游版本，请在提交前重新执行 `pnpm install` 并带上新的锁文件。',
      ''
    )
  }

  lines.push(
    '## 本地处理',
    '',
    '```bash',
    `git fetch origin ${summary.conflictBranch}`,
    `git switch -c ${summary.conflictBranch} origin/${summary.conflictBranch}  # 本地已有分支就直接 switch`,
    hasConflicts ? '# 逐个文件解决 <<<<<<< / ======= / >>>>>>> 标记' : '# 修掉检查报错的文件',
    'pnpm install',
    'pnpm run format:check && pnpm run lint:check && pnpm run typecheck',
    `git commit -am "chore(sync): 处理上游同步"`,
    `git push origin ${summary.conflictBranch}`,
    '```',
    '',
    '去掉草稿状态后合并这条 PR，`smart_core` 上会正常触发镜像构建。',
    '',
    '## 上游提交',
    '',
    ...subjects
  )

  const bodyFile = join(reportDir, 'sync-upstream-pr-body.md')
  writeFileSync(bodyFile, `${lines.join('\n')}\n`, 'utf8')
  return bodyFile
}

function writeStepSummary(summary) {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (!file) {
    return
  }

  const rows = [
    `| 项 | 值 |`,
    `| --- | --- |`,
    `| 结果 | \`${summary.status}\` |`,
    `| 目标分支 | \`${summary.targetBranch}\` |`,
    `| 上游最新提交 | \`${summary.upstreamSha.slice(0, 7) || '-'}\` |`,
    `| 新提交数 | ${summary.incomingCommits} |`,
    `| 冲突文件 | ${summary.unresolved.length ? summary.unresolved.map((file) => `\`${file}\``).join('、') : '无'} |`,
    `| 自动处理 | ${summary.autoResolved.length ? summary.autoResolved.map((item) => `\`${item.file}\``).join('、') : '无'} |`,
    `| 合并提交 | \`${summary.mergeCommit || '-'}\` |`,
    `| 镜像标签 | \`${summary.imageSuffix || '-'}\` |`
  ]

  appendFileSync(file, `${rows.join('\n')}\n\n`, 'utf8')
}

function writeOutputs(summary) {
  const file = process.env.GITHUB_OUTPUT
  if (!file) {
    return
  }

  const entries = {
    status: summary.status,
    applied: String(summary.applied),
    upstream_sha: summary.upstreamSha,
    incoming_commits: String(summary.incomingCommits),
    auto_resolved: summary.autoResolved.map((item) => item.file).join(','),
    unresolved: summary.unresolved.join(','),
    merge_commit: summary.mergeCommit,
    version: summary.version,
    image_suffix: summary.imageSuffix,
    conflict_branch: summary.conflictBranch
  }

  const text = Object.entries(entries)
    .map(([key, value]) => `${key}=${String(value ?? '').replace(/[\r\n]+/g, ' ')}`)
    .join('\n')

  appendFileSync(file, `${text}\n`, 'utf8')
}

function finish(summary) {
  writeOutputs(summary)
  writeStepSummary(summary)
  console.log(JSON.stringify(summary, null, 2))
}

function sync(options) {
  const summary = {
    status: 'error',
    applied: options.apply,
    targetBranch: git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout,
    conflictBranch: options.conflictBranch,
    upstreamSha: '',
    incomingCommits: 0,
    autoResolved: [],
    unresolved: [],
    mergeCommit: '',
    version: readVersion(),
    imageSuffix: ''
  }

  ensureCleanWorktree()
  const ref = fetchUpstream(options)
  summary.upstreamSha = git(['rev-parse', ref]).stdout
  summary.incomingCommits = countCommits(`HEAD..${ref}`)

  if (summary.incomingCommits === 0) {
    summary.status = 'up-to-date'
    return { summary, subjects: [] }
  }

  const subjects = listSubjects(`HEAD..${ref}`)
  const messageFile = writeMergeMessage(options, summary.upstreamSha, subjects)
  const patterns = loadKeepLocalPatterns()

  const merge = git(['merge', '--no-commit', '--no-ff', ref], { allowFailure: true })
  const conflicted = listConflicted()

  if (merge.status !== 0 && conflicted.length === 0) {
    abortMerge()
    const detail = [merge.stdout, merge.stderr].filter(Boolean).join('\n')
    throw new Error(`合并上游失败，但没有识别到冲突文件：\n${detail}`)
  }

  const { autoResolved, unresolved, needsLockRefresh } = resolveConflicts(
    conflicted,
    patterns,
    options
  )
  summary.autoResolved = autoResolved

  if (unresolved.length === 0 && needsLockRefresh) {
    if (!refreshLockfile()) {
      unresolved.push(lockFile)
    }
  }

  summary.unresolved = unresolved
  summary.version = readVersion()
  summary.imageSuffix = summary.version
    ? `upstream-${summary.version}-${summary.upstreamSha.slice(0, 7)}`
    : `upstream-${summary.upstreamSha.slice(0, 7)}`

  if (unresolved.length > 0) {
    if (!options.apply) {
      abortMerge()
      summary.status = 'conflict'
      return { summary, subjects }
    }

    summary.mergeCommit = createConflictBranch(options, ref, messageFile, patterns)
    summary.status = 'conflict'
    return { summary, subjects }
  }

  if (!options.apply) {
    abortMerge()
    summary.status = 'merged'
    return { summary, subjects }
  }

  summary.mergeCommit = commitMerge(messageFile)
  summary.status = 'merged'
  return { summary, subjects }
}

function main() {
  const options = parseArgs(process.argv.slice(2))
  configureIdentity(options)
  const { summary, subjects } = sync(options)

  if (summary.incomingCommits > 0) {
    const bodyFile = writePullRequestBody(options, summary, subjects)
    console.log(`Pull Request 正文：${bodyFile}`)
  }

  finish(summary)
}

try {
  main()
} catch (error) {
  abortMerge()
  console.error(`[sync-upstream] ${error.message}`)
  process.exit(1)
}
