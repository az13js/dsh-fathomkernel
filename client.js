/**
 * FathomKernel — Client half.
 *
 * One Settings section that presents the live optimization state: the goal
 * selector, the milestone ladder, the measured latency curve, the round
 * ledger, the self-evolution policy and the structured knowledge base. Every
 * value comes from `/api/fathomkernel/state`; actions post to
 * `/api/fathomkernel/action`. Colors are `--dsw-alias-*` theme tokens so the
 * page follows light and dark themes and user themes.
 *
 * The page is intentionally read-mostly: the engine owns the loop, the
 * dashboard only starts/stops it and displays what the evaluator measured.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-fathomkernel',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    /** Client locale namespace owned by this plugin. */
    const NS = 'fathomKernel'

    /** Simplified Chinese dictionary, the key-set source of truth. */
    const zh = {
      'section.label': 'FathomKernel',
      'title': 'FathomKernel 自进化优化',
      'subtitle': 'JustGoal 目标 · 里程碑阶梯 · 结构化知识库 · 自进化循环',
      'refresh': '刷新',
      'pause': '暂停',
      'openReport': '打开报告',
      'bestSource': '查看最优源码',
      'noGoal': '还没有 FathomKernel 目标',
      'noGoalHint': '在会话里让 Agent 调用 fk_goal 创建目标，创建后这里会显示进度。',
      'loading': '正在读取优化状态…',
      'error': '读取失败',
      'goal': '目标',
      'status': '状态',
      'rounds': '轮次',
      'baseline': '基线',
      'best': '当前最优',
      'speedup': '加速比',
      'target': '目标',
      'milestones': '里程碑',
      'curve': '实测延迟曲线',
      'ledger': '最近轮次',
      'policy': '自进化策略',
      'knowledge': '结构化知识库',
      'next': '下一步',
      'emptyRounds': '暂无轮次数据，先运行几轮。',
      'emptyKnowledge': '知识库为空。每轮成功与失败都会自动沉淀为 pattern / antipattern。',
      'chartHint': '圆点：每轮实测；折线：历史最优；虚线：基线。',
      'stopped': '已暂停',
      'busy': '处理中…',
      'status.running': '运行中',
      'status.idle': '空闲',
      'status.paused': '已暂停',
      'status.complete': '已完成',
      'status.error': '错误',
      'round': '轮',
      'scale': '尺度',
      'result': '结果',
      'latency': '延迟',
      'delta': '变化',
      'milestone': '里程碑',
      'ok': '通过',
      'failed': '失败',
      'bestTag': '最优',
      'seed': '基线种子',
      'pattern': '模式',
      'antipattern': '反模式',
      'insight': '洞察',
      'conf': '置信度',
      'tries': '次',
      'win': '胜率',
      'selectGoal': '选择目标',
      'task': '任务',
      'entry': '入口',
      'stateDir': '状态目录',
      'runner': '后台运行',
      'remaining': '剩余',
      'started': '开始于',
      'exportHint': '报告与最优源码写入目标工作目录。',
      'code': '源码',
      'report': '报告',
      'errorPrefix': '错误',
      'actionFailed': '操作失败',
      'deadline': '截止',
      'noDeadline': '无截止',
      'proposer': '提案器',
      'crossTask': '跨任务',
      'goals': '个目标',
      'readOnly': '只读看板：创建、运行与恢复目标请在会话里使用 fk_goal / fk_run / fk_resume。',
      'kbTitle': '结构化知识库',
      'kbAll': '全部',
      'kbTag': '标签',
      'kbSearch': '搜索知识库…',
      'kbEmpty': '没有匹配的知识条目。每轮成功与失败都会沉淀为 pattern / antipattern / insight。',
      'kbCount': '条',
      'kbMore': '加载更多',
      'kbScrollHint': '滚动加载全部条目',
      'kbScrollHintMore': '继续向下滚动加载更多',
      'kbLoading': '正在加载…',
      'kbClear': '清除筛选',
      'kbWins': '胜',
      'kbLosses': '负',
      'kbUpdated': '更新于',
      'kbTask': '任务',
      'kbLang': '语言',
      'noMeasurements': '还没有可绘制的测量',
      'noMeasurementsHint': '目标是只读看板；在会话里用 fk_run 跑几轮后这里会出现曲线。',
      'goalPickerLabel': '切换目标',
    }

    /** English dictionary. */
    const en = {
      'section.label': 'FathomKernel',
      'title': 'FathomKernel Self-Evolving Optimizer',
      'subtitle': 'JustGoal · milestone ladder · structured knowledge · self-evolution loop',
      'refresh': 'Refresh',
      'pause': 'Pause',
      'openReport': 'Open report',
      'bestSource': 'Best source',
      'noGoal': 'No FathomKernel goal yet',
      'noGoalHint': 'Ask the agent to call fk_goal in the session; progress shows up here.',
      'loading': 'Reading optimization state…',
      'error': 'Request failed',
      'goal': 'Goal',
      'status': 'Status',
      'rounds': 'Rounds',
      'baseline': 'Baseline',
      'best': 'Best',
      'speedup': 'Speedup',
      'target': 'Target',
      'milestones': 'Milestones',
      'curve': 'Measured latency',
      'ledger': 'Recent rounds',
      'policy': 'Self-evolution policy',
      'knowledge': 'Structured knowledge',
      'next': 'Next',
      'emptyRounds': 'No rounds yet. Run a few.',
      'emptyKnowledge': 'Knowledge is empty. Every win and failure is distilled into a pattern or antipattern.',
      'chartHint': 'Dots: measured rounds. Line: best so far. Dashed: baseline.',
      'stopped': 'Paused',
      'busy': 'Working…',
      'status.running': 'running',
      'status.idle': 'idle',
      'status.paused': 'paused',
      'status.complete': 'complete',
      'status.error': 'error',
      'round': 'round',
      'scale': 'scale',
      'result': 'result',
      'latency': 'latency',
      'delta': 'delta',
      'milestone': 'milestone',
      'ok': 'ok',
      'failed': 'failed',
      'bestTag': 'best',
      'seed': 'seed baseline',
      'pattern': 'pattern',
      'antipattern': 'antipattern',
      'insight': 'insight',
      'conf': 'conf',
      'tries': 'tries',
      'win': 'win',
      'selectGoal': 'Select goal',
      'task': 'Task',
      'entry': 'Entry',
      'stateDir': 'State',
      'runner': 'Runner',
      'remaining': 'remaining',
      'started': 'started',
      'exportHint': 'The report and best source are written into the goal workdir.',
      'code': 'source',
      'report': 'report',
      'errorPrefix': 'Error',
      'actionFailed': 'Action failed',
      'deadline': 'deadline',
      'noDeadline': 'no deadline',
      'proposer': 'proposer',
      'crossTask': 'cross-task',
      'goals': 'goals',
      'readOnly': 'Read-only: create, run and resume goals from the session with fk_goal / fk_run / fk_resume.',
      'kbTitle': 'Structured knowledge',
      'kbAll': 'All',
      'kbTag': 'Tag',
      'kbSearch': 'Search knowledge…',
      'kbEmpty': 'No matching entries. Every win and failure is distilled into a pattern, antipattern or insight.',
      'kbCount': 'entries',
      'kbMore': 'Load more',
      'kbScrollHint': 'Scroll to load every entry',
      'kbScrollHintMore': 'Scroll down for more',
      'kbLoading': 'Loading…',
      'kbClear': 'Clear filters',
      'kbWins': 'wins',
      'kbLosses': 'losses',
      'kbUpdated': 'updated',
      'kbTask': 'task',
      'kbLang': 'language',
      'noMeasurements': 'No measurements to plot yet',
      'noMeasurementsHint': 'The dashboard is read-only; run a few rounds with fk_run to fill the curve.',
      'goalPickerLabel': 'Switch goal',
    }

    /** Format a measurement compactly. */
    function num(value, digits = 3) {
      if (value === null || value === undefined || Number.isNaN(Number(value))) return '—'
      const number = Number(value)
      if (Math.abs(number) >= 1000) return number.toFixed(0)
      if (Math.abs(number) >= 100) return number.toFixed(1)
      if (Math.abs(number) >= 1) return number.toFixed(digits)
      return number.toPrecision(3)
    }

    /** Resolve one API path against the page base. */
    function apiUrl(path) {
      return new URL(path, document.baseURI).toString()
    }

    /** GET one JSON endpoint. */
    async function getJson(path) {
      const response = await fetch(apiUrl(path), { credentials: 'same-origin', headers: { accept: 'application/json' } })
      const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
      if (!response.ok || payload.ok === false) throw new Error(payload.error ?? `HTTP ${response.status}`)
      return payload
    }

    /** POST one dashboard action. */
    async function postAction(body) {
      const response = await fetch(apiUrl('api/fathomkernel/action'), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))
      if (!response.ok || payload.ok === false) throw new Error(payload.error ?? `HTTP ${response.status}`)
      return payload
    }

    /** A status pill with a colored dot. */
    function StatusPill({ status, t }) {
      const label = t(`status.${status ?? 'idle'}`)
      return h('span', { className: `fk-pill fk-pill-${status ?? 'idle'}` }, h('span', { className: 'fk-dot' }), label)
    }

    /** Small inline icon used in the page header. */
    function ForgeGlyph() {
      return h('svg', { viewBox: '0 0 64 64', width: 26, height: 26, 'aria-hidden': true },
        h('path', { d: 'M32 6 56 19v26L32 58 8 45V19z', fill: 'none', stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 3 }),
        h('path', { d: 'M18 44c6-1 9-6 13-13s8-10 15-11', fill: 'none', stroke: 'var(--dsw-alias-state-success-primary)', strokeWidth: 3.2, strokeLinecap: 'round' }),
        h('path', { d: 'M39 19h8v8', fill: 'none', stroke: 'var(--dsw-alias-brand-primary)', strokeWidth: 3.2, strokeLinecap: 'round' }))
    }

    /** Build the log/linear chart geometry from the round ledger. */
    function buildChart(goal, rounds) {
      const width = 820
      const height = 250
      const left = 58
      const right = 18
      const top = 18
      const bottom = 34
      const plotWidth = width - left - right
      const plotHeight = height - top - bottom
      const measured = (rounds ?? []).filter((round) => Number.isFinite(round.metric) && round.metric > 0)
      const baseline = Number.isFinite(goal?.baseline?.metric) && goal.baseline.metric > 0 ? goal.baseline.metric : null
      const targetMetric = goal?.spec?.target?.kind === 'metric' ? goal.spec.target.value : null
      const values = [...measured.map((round) => round.metric), ...(baseline ? [baseline] : []), ...(targetMetric ? [targetMetric] : [])]
      if (values.length === 0) return null
      let min = Math.min(...values)
      let max = Math.max(...values)
      if (!(max > min)) {
        min = min * 0.9
        max = max * 1.1 || 1
      }
      const useLog = max / min > 25
      const pad = useLog ? 0 : (max - min) * 0.08
      const low = useLog ? min / 1.35 : Math.max(0, min - pad)
      const high = useLog ? max * 1.35 : max + pad
      const xOf = (index) => left + (measured.length <= 1 ? 24 : (index / (measured.length - 1)) * plotWidth)
      const yOf = (value) => {
        const ratio = useLog
          ? (Math.log(value) - Math.log(low)) / (Math.log(high) - Math.log(low))
          : (value - low) / (high - low)
        return top + (1 - Math.max(0, Math.min(1, ratio))) * plotHeight
      }
      const points = measured.map((round, index) => ({ x: xOf(index), y: yOf(round.metric), round }))
      let running = null
      const bestPoints = points.map((point) => {
        if (running === null || point.round.metric < running) running = point.round.metric
        return { x: point.x, y: yOf(running), round: point.round, best: running }
      })
      const ticks = Array.from({ length: 4 }, (_, index) => {
        const ratio = index / 3
        const value = useLog
          ? Math.exp(Math.log(low) + ratio * (Math.log(high) - Math.log(low)))
          : low + ratio * (high - low)
        return { value, y: top + (1 - ratio) * plotHeight }
      })
      return { width, height, left, right, top, bottom, plotWidth, plotHeight, low, high, useLog, points, bestPoints, ticks, baseline, targetMetric, yOf }
    }

    /**
     * The SVG chart. Handles the degenerate cases a real run produces: no
     * measurement yet, and a single round (a line needs two points, so the seed
     * is drawn as a labelled marker instead of an empty plot).
     */
    function Curve({ goal, rounds, t }) {
      const chart = useMemo(() => buildChart(goal, rounds), [goal, rounds])
      if (!chart) {
        return h('div', { className: 'fk-chart-empty' },
          h('div', { className: 'fk-empty-title' }, t('noMeasurements')),
          h('div', { className: 'fk-empty-text' }, t('noMeasurementsHint')))
      }
      const unit = goal?.spec?.metric?.unit ?? ''
      const baselineY = chart.baseline ? chart.yOf(chart.baseline) : null
      const targetY = chart.targetMetric ? chart.yOf(chart.targetMetric) : null
      return h('div', { className: 'fk-chart' },
        h('svg', { viewBox: `0 0 ${chart.width} ${chart.height}`, role: 'img', 'aria-label': t('curve'), preserveAspectRatio: 'xMidYMid meet' },
          ...chart.ticks.map((tick, index) => h('g', { key: `tick-${index}` },
            h('line', { x1: chart.left, y1: tick.y, x2: chart.width - chart.right, y2: tick.y, stroke: 'var(--dsw-alias-border-l1)', strokeDasharray: index === 0 ? '0' : '3 4' }),
            h('text', { x: chart.left - 8, y: tick.y + 4, textAnchor: 'end', fill: 'var(--dsw-alias-label-secondary)', fontSize: 11 }, `${num(tick.value)}`))),
          baselineY !== null ? h('g', { key: 'baseline' },
            h('line', { x1: chart.left, y1: baselineY, x2: chart.width - chart.right, y2: baselineY, stroke: 'var(--dsw-alias-state-warn-primary)', strokeDasharray: '6 5', strokeWidth: 1.4 }),
            h('text', { x: chart.width - chart.right, y: baselineY - 6, textAnchor: 'end', fill: 'var(--dsw-alias-state-warn-primary)', fontSize: 11 }, t('baseline'))) : null,
          targetY !== null ? h('g', { key: 'target' },
            h('line', { x1: chart.left, y1: targetY, x2: chart.width - chart.right, y2: targetY, stroke: 'var(--dsw-alias-brand-primary)', strokeDasharray: '2 5', strokeWidth: 1.2 }),
            h('text', { x: chart.left + 6, y: targetY - 6, fill: 'var(--dsw-alias-brand-primary)', fontSize: 11 }, t('target'))) : null,
          chart.points.length > 1 ? h('polyline', { key: 'best', points: chart.bestPoints.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' '), fill: 'none', stroke: 'var(--dsw-alias-state-success-primary)', strokeWidth: 2.2, strokeLinejoin: 'round', strokeLinecap: 'round' }) : null,
          ...chart.points.map((point, index) => h('g', { key: `pt-${index}` },
            h('circle', {
              cx: point.x,
              cy: point.y,
              r: point.round.improved ? 4.6 : 3.2,
              fill: point.round.ok ? (point.round.improved ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-bg-base)') : 'var(--dsw-alias-state-error-primary)',
              stroke: point.round.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)',
              strokeWidth: 1.5,
            }),
            h('text', { x: point.x, y: point.y - 10, textAnchor: 'middle', fill: 'var(--dsw-alias-label-secondary)', fontSize: 10 },
              `${num(point.round.metric)}${unit ? ' ' + unit : ''}`))),
          h('text', { x: chart.left, y: chart.height - 10, fill: 'var(--dsw-alias-label-secondary)', fontSize: 11 }, `${t('round')} 0`),
          chart.points.length > 1
            ? h('text', { x: chart.width - chart.right, y: chart.height - 10, textAnchor: 'end', fill: 'var(--dsw-alias-label-secondary)', fontSize: 11 }, `${t('round')} ${chart.points.at(-1)?.round?.round ?? 0}`)
            : null),
        h('div', { className: 'fk-chart-hint' }, t('chartHint')))
    }

    /** Milestone ladder. */
    function Milestones({ goal, t }) {
      const milestones = goal?.milestones ?? []
      const current = goal?.milestone?.current
      return h('ol', { className: 'fk-ladder' }, ...milestones.map((milestone) => {
        const state = milestone.achieved ? 'done' : milestone.id === current ? 'current' : 'open'
        return h('li', { key: milestone.id, className: `fk-ladder-item fk-ladder-${state}` },
          h('span', { className: 'fk-ladder-mark' }, milestone.achieved ? '✓' : milestone.id === current ? '›' : '·'),
          h('div', { className: 'fk-ladder-body' },
            h('div', { className: 'fk-ladder-title' }, `${milestone.id} · ${milestone.title}`),
            h('div', { className: 'fk-ladder-detail' }, milestone.achieved ? `${milestone.detail} — round ${milestone.achievedAtRound ?? 0}` : milestone.detail)))
      }))
    }

    /** One stat card. */
    function Stat({ label, value, hint }) {
      return h('div', { className: 'fk-stat' },
        h('div', { className: 'fk-stat-label' }, label),
        h('div', { className: 'fk-stat-value' }, value),
        hint ? h('div', { className: 'fk-stat-hint' }, hint) : null)
    }

    /** Kind chip. */
    function KindChip({ kind, t }) {
      return h('span', { className: `fk-kind fk-kind-${kind}` }, t(kind))
    }

    /** Page size for one knowledge query. */
    const KB_PAGE = 40

    /**
     * The structured knowledge base as a browsable list: kind filter, tag facet,
     * text search and paging all query the read-only knowledge route.
     */
    function KnowledgeBrowser({ t, stats, tick = 0 }) {
      const [data, setData] = useState(null)
      const [kind, setKind] = useState('')
      const [tag, setTag] = useState('')
      const [query, setQuery] = useState('')
      const [offset, setOffset] = useState(0)
      const [error, setError] = useState('')
      const [paging, setPaging] = useState(false)
      const alive = useRef(true)
      // "Load more" may only append to the result set it belongs to, and only
      // one page request may be in flight: both are refs because neither needs
      // a render.
      const pagingLock = useRef(false)

      const params = useMemo(() => {
        const search = new URLSearchParams()
        if (kind) search.set('kind', kind)
        if (tag) search.set('tag', tag)
        if (query.trim()) search.set('q', query.trim())
        search.set('limit', String(KB_PAGE))
        return search
      }, [kind, tag, query])

      const currentParams = useRef(params.toString())

      const load = useCallback(async (nextOffset) => {
        const search = new URLSearchParams(params)
        search.set('offset', String(nextOffset ?? 0))
        const mine = search.toString()
        try {
          const payload = await getJson(`api/fathomkernel/knowledge?${mine}`)
          // Either the page moved on, or the filters changed while this
          // request was in flight. Dropping it keeps stale rows out of the list.
          if (!alive.current || currentParams.current !== String(params)) return
          setData((previous) => (nextOffset && previous
            ? { ...payload, entries: [...previous.entries, ...payload.entries] }
            : payload))
          setOffset(nextOffset ?? 0)
          setError('')
        } catch (cause) {
          if (alive.current) setError(String(cause?.message ?? cause))
        } finally {
          if (nextOffset) {
            pagingLock.current = false
            if (alive.current) setPaging(false)
          }
        }
      }, [params])

      useEffect(() => {
        alive.current = true
        currentParams.current = String(params)
        pagingLock.current = false
        setPaging(false)
        load(0)
        return () => { alive.current = false }
      }, [load])

      // Follow the base while the agent works: the page polls every 3.5s, and a
      // knowledge base that only refreshes when the user touches a filter makes
      // a running goal look like it is learning nothing.
      const firstTick = useRef(tick)
      useEffect(() => {
        if (tick === firstTick.current) return
        // A reader who paged past the first screen keeps their position; the
        // next filter change is what pulls a fresh first page for them.
        if (offset !== 0 || pagingLock.current) return
        load(0)
      }, [tick, offset, load])

      const total = data?.all?.total ?? stats?.total ?? 0
      const shown = data?.entries?.length ?? 0
      const matched = data?.matched ?? shown

      const more = useCallback(() => {
        if (pagingLock.current) return
        pagingLock.current = true
        setPaging(true)
        load(offset + KB_PAGE)
      }, [load, offset])

      // The scroll box is the only scroller, so an IntersectionObserver rooted
      // on it decides when the sentinel is close enough to prefetch the next
      // page. Observing the container keeps this independent of the window.
      //
      // `shown` is a dependency on purpose: every page that lands has to
      // re-observe the sentinel, whose position moved down with the new rows.
      const scroller = useRef(null)
      const reached = useRef(null)
      const hasMore = shown < matched
      useEffect(() => {
        const root = scroller.current
        const sentinel = reached.current
        if (!root || !sentinel || !hasMore) return undefined
        // jsdom and older browsers have no IntersectionObserver; the list then
        // simply stops paging instead of taking the whole page down.
        if (typeof IntersectionObserver !== 'function') return undefined
        const observer = new IntersectionObserver((records) => {
          if (records.some((record) => record.isIntersecting)) more()
        }, { root, rootMargin: '160px 0px' })
        observer.observe(sentinel)
        return () => observer.disconnect()
      }, [more, hasMore, shown])

      // The header shows both numbers whenever a filter is active: "3 of 800"
      // is the question a reader actually asks of a filtered list.
      const filtered = Boolean(kind || tag || query)
      const counts = filtered
        ? `${matched} / ${total} ${t('kbCount')}`
        : `${total} ${t('kbCount')}`
      const kinds = [
        { value: '', label: t('kbAll') },
        { value: 'pattern', label: t('pattern') },
        { value: 'antipattern', label: t('antipattern') },
        { value: 'insight', label: t('insight') },
      ]

      return h('section', { className: 'fk-card fk-kb-card' },
        h('div', { className: 'fk-kb-head' },
          h('div', { className: 'fk-card-title' }, `${t('kbTitle')} · ${counts}`),
          h('div', { className: 'fk-kb-tools' },
            h('div', { className: 'fk-kb-kinds' }, ...kinds.map((entry) => h('button', {
              key: entry.value || 'all',
              className: `fk-kb-filter${kind === entry.value ? ' fk-kb-filter-on' : ''}`,
              onClick: () => setKind(entry.value),
            }, entry.label))),
            h('input', {
              className: 'fk-kb-search',
              type: 'search',
              placeholder: t('kbSearch'),
              value: query,
              onChange: (event) => setQuery(event.target.value),
            }),
            (kind || tag || query)
              ? h('button', { className: 'fk-kb-clear', onClick: () => { setKind(''); setTag(''); setQuery('') } }, t('kbClear'))
              : null)),
        data?.facets?.tags?.length
          ? h('div', { className: 'fk-kb-facets' }, ...data.facets.tags.map((facet) => h('button', {
            key: facet.name,
            className: `fk-kb-tag${tag === facet.name ? ' fk-kb-tag-on' : ''}`,
            onClick: () => setTag(tag === facet.name ? '' : facet.name),
          }, `${facet.name} ${facet.count}`)))
          : null,
        error ? h('div', { className: 'fk-error' }, `${t('error')}: ${error}`) : null,
        h('div', { className: 'fk-kb-scroll', ref: scroller },
          !data ? h('div', { className: 'fk-empty' }, t('loading'))
            : shown === 0 ? h('div', { className: 'fk-empty' }, t('kbEmpty'))
              : h('ul', { className: 'fk-kb-list' }, ...data.entries.map((entry) => h('li', { key: entry.id, className: 'fk-kb-item' },
              h('div', { className: 'fk-kb-item-top' },
                h(KindChip, { kind: entry.kind, t }),
                h('span', { className: 'fk-kb-conf' }, `${t('conf')} ${num(entry.confidence, 2)}`),
                h('span', { className: 'fk-kb-meta' }, `${entry.wins} ${t('kbWins')} / ${entry.losses} ${t('kbLosses')}`),
                entry.taskKind ? h('span', { className: 'fk-kb-meta' }, `${t('kbTask')} ${entry.taskKind}`) : null,
                entry.language ? h('span', { className: 'fk-kb-meta' }, `${t('kbLang')} ${entry.language}`) : null,
                h('span', { className: 'fk-kb-when' }, `${t('kbUpdated')} ${new Date(entry.updatedAt).toLocaleDateString()}`)),
              h('div', { className: 'fk-kb-text' }, entry.text),
              entry.tags.length > 0
                ? h('div', { className: 'fk-kb-item-tags' }, ...entry.tags.map((name) => h('button', {
                  key: name,
                  className: `fk-kb-tag${tag === name ? ' fk-kb-tag-on' : ''}`,
                  onClick: () => setTag(tag === name ? '' : name),
                }, name)))
                : null)),
              h('li', { key: 'sentinel', ref: reached, className: 'fk-kb-sentinel', 'aria-hidden': true }))),
        h('div', { className: 'fk-kb-foot' },
          h('span', { className: 'fk-kb-shown' }, `${shown} / ${matched}`),
          h('span', { className: 'fk-kb-hint' }, shown < matched
            ? (paging ? t('kbLoading') : t('kbScrollHintMore'))
            : t('kbScrollHint'))))
    }

    /** The settings page. */
    function ForgePage(props) {
      const t = props.t ?? ((key) => key)
      const [payload, setPayload] = useState(null)
      const [selected, setSelected] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      const [tick, setTick] = useState(0)
      const alive = useRef(true)

      const load = useCallback(async (silent = false) => {
        try {
          const query = selected ? `?goal=${encodeURIComponent(selected)}` : ''
          const response = await getJson(`api/fathomkernel/state${query}`)
          if (!alive.current) return
          setPayload(response.status)
          setError('')
          if (!selected && response.status?.goal?.id) setSelected(response.status.goal.id)
        } catch (cause) {
          if (!alive.current) return
          if (!silent) setError(String(cause?.message ?? cause))
        }
      }, [selected])

      useEffect(() => {
        alive.current = true
        load(false)
        const timer = setInterval(() => {
          if (document.visibilityState !== 'visible') return
          load(true)
          // One tick per poll drives the knowledge browser's silent refresh,
          // so the whole page updates on the same beat.
          setTick((value) => value + 1)
        }, 3500)
        return () => {
          alive.current = false
          clearInterval(timer)
        }
      }, [load])

      const status = payload?.goal ?? null
      const goal = status
      const goals = payload?.goals ?? []
      const rounds = payload?.rounds ?? []
      const policy = payload?.policy ?? null
      const knowledge = payload?.knowledge ?? null
      const running = Boolean(payload?.runner?.running || goal?.status === 'running')
      const selectedGoal = goal?.id ?? ''

      const act = useCallback(async (body, message) => {
        setBusy(true)
        setError('')
        try {
          const response = await postAction(body)
          if (response.status) {
            setPayload(response.status)
            if (response.status.goal?.id) setSelected(response.status.goal.id)
          }
          setNotice(message ?? '')
          setTimeout(() => setNotice(''), 4000)
        } catch (cause) {
          setError(String(cause?.message ?? cause))
        } finally {
          setBusy(false)
        }
      }, [])

      const stop = () => {
        if (!selectedGoal) return
        act({ action: 'stop', goalId: selectedGoal }, t('stopped'))
      }

      if (!payload) {
        return h('div', { className: 'fk-page' },
          h('style', null, CSS),
          h('div', { className: 'fk-head' }, h(ForgeGlyph), h('div', null, h('h2', { className: 'fk-title' }, t('title')), h('div', { className: 'fk-subtitle' }, t('subtitle')))),
          h('div', { className: 'fk-empty' }, error ? `${t('error')}: ${error}` : t('loading')))
      }

      return h('div', { className: 'fk-page' },
        h('style', null, CSS),
        h('div', { className: 'fk-head' },
          h('div', { className: 'fk-head-main' },
            h(ForgeGlyph),
            h('div', null,
              h('h2', { className: 'fk-title' }, t('title')),
              h('div', { className: 'fk-subtitle' }, t('subtitle')))),
          h('div', { className: 'fk-head-actions' },
            goals.length > 0 ? h('label', { className: 'fk-select-wrap' },
              h('span', null, t('selectGoal')),
              h('select', { className: 'fk-select', value: selected, onChange: (event) => setSelected(event.target.value) },
                ...goals.map((entry) => h('option', { key: entry.id, value: entry.id }, `${entry.name} — ${entry.status}`)))) : null,
            h('button', { className: 'fk-btn', onClick: () => load(false), disabled: busy }, t('refresh')))),
        notice ? h('div', { className: 'fk-notice' }, notice) : null,
        error ? h('div', { className: 'fk-error' }, `${t('error')}: ${error}`) : null,
        !goal ? h('div', { className: 'fk-empty-card' },
          h('div', { className: 'fk-empty-title' }, t('noGoal')),
          h('div', { className: 'fk-empty-text' }, t('noGoalHint')),
          h('div', { className: 'fk-empty-text' }, t('readOnly')))
          : h(React.Fragment, null,
            h('div', { className: 'fk-goal-card' },
              h('div', { className: 'fk-goal-top' },
                h('div', { className: 'fk-goal-name' }, goal.name),
                h(StatusPill, { status: goal.status, t }),
                h('span', { className: 'fk-goal-id' }, goal.id)),
              goal.description ? h('div', { className: 'fk-goal-desc' }, goal.description) : null,
              h('div', { className: 'fk-goal-meta' },
                h('span', null, `${t('task')}: ${goal.spec?.taskKind} / ${goal.spec?.language}`),
                h('span', null, `${t('entry')}: ${goal.spec?.entry}`),
                h('span', null, `${t('proposer')}: ${goal.spec?.proposer?.kind ?? 'llm'}`),
                h('span', null, `${t('deadline')}: ${goal.spec?.deadline ? new Date(goal.spec.deadline).toLocaleString() : t('noDeadline')}`)),
              h('div', { className: 'fk-controls' },
                h('button', { className: 'fk-btn', onClick: stop, disabled: busy || !running }, t('pause')),
                h('a', { className: 'fk-btn fk-link', href: apiUrl(`api/fathomkernel/report?goal=${encodeURIComponent(selectedGoal)}`), target: '_blank', rel: 'noreferrer' }, t('openReport')),
                h('a', { className: 'fk-btn fk-link', href: apiUrl(`api/fathomkernel/code?goal=${encodeURIComponent(selectedGoal)}&round=best`), target: '_blank', rel: 'noreferrer' }, t('bestSource'))),
              h('div', { className: 'fk-readonly' }, t('readOnly')),
              payload?.runner?.running ? h('div', { className: 'fk-runner' },
                `${t('runner')}: ${payload.runner.roundsDone} / ${payload.runner.roundsDone + payload.runner.remaining} · ${t('remaining')} ${payload.runner.remaining} · ${t('started')} ${new Date(payload.runner.startedAt).toLocaleTimeString()}`) : null),
            h('div', { className: 'fk-stats' },
              h(Stat, { label: t('rounds'), value: `${goal.rounds ?? 0}`, hint: `${t('milestone')} ${goal.milestone?.current ?? 'm0'}` }),
              h(Stat, { label: t('baseline'), value: goal.baseline ? `${num(goal.baseline.metric)} ${goal.spec?.metric?.unit ?? ''}` : '—', hint: goal.baseline?.source ?? '' }),
              h(Stat, { label: t('best'), value: goal.best ? `${num(goal.best.metric)} ${goal.spec?.metric?.unit ?? ''}` : '—', hint: goal.best ? `${t('round')} ${goal.best.round}` : '' }),
              h(Stat, { label: t('speedup'), value: goal.best?.speedup ? `${num(goal.best.speedup)}×` : '—', hint: goal.spec?.target ? `${t('target')} ${goal.spec.target.kind === 'metric' ? num(goal.spec.target.value) : num(goal.spec.target.value) + '×'}` : '' })),
            h('div', { className: 'fk-grid fk-grid-ladder' },
              h('section', { className: 'fk-card fk-card-ladder' },
                h('div', { className: 'fk-card-title' }, t('milestones')),
                h(Milestones, { goal, t })),
              h('section', { className: 'fk-card fk-card-chart' },
                h('div', { className: 'fk-card-title' }, t('curve')),
                h(Curve, { goal, rounds, t }))),
            h('div', { className: 'fk-grid fk-grid-2' },
              h('section', { className: 'fk-card' },
                h('div', { className: 'fk-card-title' }, t('ledger')),
                rounds.length === 0 ? h('div', { className: 'fk-empty' }, t('emptyRounds'))
                  : h('div', { className: 'fk-table-wrap' },
                    h('table', { className: 'fk-table' },
                      h('thead', null, h('tr', null,
                        ...['round', 'scale', 'result', 'latency', 'speedup', 'delta', 'milestone'].map((key) => h('th', { key }, t(key))))),
                      h('tbody', null, ...rounds.slice().reverse().slice(0, 14).map((round) => h('tr', { key: `r-${round.round}`, className: round.improved ? 'fk-row-best' : '' },
                        h('td', null, round.seed ? t('seed') : `r${round.round}`),
                        h('td', null, round.scale),
                        h('td', null, round.ok ? t('ok') : h('span', { className: 'fk-fail', title: round.error ?? '' }, t('failed'))),
                        h('td', { className: 'fk-num' }, round.ok ? `${num(round.metric)} ${round.unit ?? ''}` : '—'),
                        h('td', { className: 'fk-num' }, Number.isFinite(round.speedup) ? `${num(round.speedup)}×` : '—'),
                        h('td', { className: `fk-num ${round.delta > 0 ? 'fk-up' : round.delta < 0 ? 'fk-down' : ''}` }, Number.isFinite(round.delta) ? `${round.delta >= 0 ? '+' : ''}${(round.delta * 100).toFixed(1)}%` : '—'),
                        h('td', null, round.milestone?.after ?? '—')))))),
              h('section', { className: 'fk-card' },
                h('div', { className: 'fk-kb-head' },
                  h('div', { className: 'fk-card-title fk-card-title-flush' }, t('policy')),
                  knowledge ? h('div', { className: 'fk-kb-counts' },
                    h('span', null, `${knowledge.byKind?.pattern ?? 0} ${t('pattern')}`),
                    h('span', null, `${knowledge.byKind?.antipattern ?? 0} ${t('antipattern')}`),
                    h('span', null, `${knowledge.byKind?.insight ?? 0} ${t('insight')}`)) : null),
                policy ? h('div', { className: 'fk-policy' },
                  h('div', { className: 'fk-policy-rounds' }, `${policy.rounds} ${t('rounds')}${payload?.meta ? ` · ${t('crossTask')} ${payload.meta.goals ?? 0} ${t('goals')}` : ''}`),
                  ...policy.arms.map((arm) => h('div', { className: 'fk-arm', key: arm.scale },
                    h('span', { className: 'fk-arm-name' }, arm.scale),
                    h('div', { className: 'fk-arm-bar' }, h('div', { className: 'fk-arm-fill', style: { width: `${Math.round(arm.mean * 100)}%` } })),
                    h('span', { className: 'fk-arm-meta' }, `${arm.attempts} ${t('tries')} · ${Math.round(arm.mean * 100)}% ${t('win')}`))),
                  policy.notes?.length ? h('ul', { className: 'fk-notes' }, ...policy.notes.slice(0, 3).map((note, index) => h('li', { key: index }, note.text))) : null)
                  : h('div', { className: 'fk-empty' }, '—'))),
            h(KnowledgeBrowser, { t, stats: knowledge, tick }),
            h('div', { className: 'fk-foot' },
              h('span', null, `${t('stateDir')}: ${payload?.stateDir ?? ''}`),
              h('span', null, `${t('next')}: ${payload?.nextHint ?? ''}`)))))
    }

    /** All page styles. Every color is a theme token. */
    const CSS = `
      .fk-page { padding: 22px 26px 56px; max-width: 1120px; margin: 0 auto; color: var(--dsw-alias-label-primary); font-size: 13px; line-height: 1.45; }
      .fk-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
      .fk-head-main { display: flex; align-items: center; gap: 10px; min-width: 0; flex: 1 1 auto; }
      .fk-title { font-size: 17px; font-weight: 600; margin: 0; white-space: nowrap; }
      .fk-subtitle { color: var(--dsw-alias-label-secondary); font-size: 12px; margin-top: 2px; }
      .fk-head-actions { display: flex; align-items: center; gap: 8px; flex: none; flex-wrap: wrap; justify-content: flex-end; }
      .fk-select-wrap { display: flex; align-items: center; gap: 6px; color: var(--dsw-alias-label-secondary); font-size: 12px; white-space: nowrap; flex: none; }
      .fk-select { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 5px 8px; font: inherit; width: 260px; min-width: 0; }
      .fk-btn { appearance: none; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border-radius: 7px; padding: 6px 11px; font: inherit; font-size: 12px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; justify-content: center; white-space: nowrap; }
      .fk-btn:hover:not(:disabled) { background: var(--dsw-alias-bg-layer-2); border-color: var(--dsw-alias-border-l2); }
      .fk-btn:disabled { opacity: .45; cursor: default; }
      .fk-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
      .fk-btn-primary:hover:not(:disabled) { background: var(--dsw-alias-brand-primary); opacity: .9; }
      .fk-link { color: var(--dsw-alias-label-primary); }
      .fk-notice { margin-bottom: 12px; padding: 7px 10px; border-radius: 7px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
      .fk-error { margin-bottom: 12px; padding: 8px 10px; border-radius: 7px; background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
      .fk-goal-card { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 11px; padding: 14px 16px; margin-bottom: 14px; }
      .fk-goal-top { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .fk-goal-name { font-size: 15px; font-weight: 600; }
      .fk-goal-id { color: var(--dsw-alias-label-secondary); font-size: 11px; font-family: var(--dsw-alias-font-mono, monospace); }
      .fk-goal-desc { color: var(--dsw-alias-label-secondary); font-size: 12px; margin-top: 6px; max-width: 900px; }
      .fk-goal-meta { display: flex; flex-wrap: wrap; gap: 14px; color: var(--dsw-alias-label-secondary); font-size: 11.5px; margin: 8px 0 12px; }
      .fk-controls { display: flex; flex-wrap: wrap; gap: 7px; }
      .fk-runner { margin-top: 10px; color: var(--dsw-alias-brand-primary); font-size: 12px; }
      .fk-pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 9px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .fk-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
      .fk-pill-running { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
      .fk-pill-running .fk-dot { background: var(--dsw-alias-state-success-primary); }
      .fk-pill-paused { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
      .fk-pill-paused .fk-dot { background: var(--dsw-alias-state-warn-primary); }
      .fk-pill-complete { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
      .fk-pill-complete .fk-dot { background: var(--dsw-alias-brand-primary); }
      .fk-pill-error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .fk-pill-error .fk-dot { background: var(--dsw-alias-state-error-primary); }
      .fk-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 14px; }
      .fk-stat { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 11px 13px; min-width: 0; }
      .fk-stat-label { color: var(--dsw-alias-label-secondary); font-size: 11px; }
      .fk-stat-value { font-size: 19px; font-weight: 600; margin-top: 3px; font-variant-numeric: tabular-nums; }
      .fk-stat-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .fk-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(340px, 100%), 1fr)); gap: 12px; margin-bottom: 14px; align-items: start; }
      .fk-grid-2 { grid-template-columns: repeat(auto-fit, minmax(min(340px, 100%), 1fr)); }
      .fk-card { background: var(--dsw-alias-bg-layer-1); border: 1px solid var(--dsw-alias-border-l1); border-radius: 11px; padding: 14px 16px; min-width: 0; }
      .fk-card-title { font-size: 12px; font-weight: 600; margin-bottom: 10px; }
      .fk-card-title-flush { margin-bottom: 0; }
      .fk-card > .fk-kb-head { margin-bottom: 10px; }
      .fk-grid-ladder { grid-template-columns: repeat(auto-fit, minmax(min(400px, 100%), 1fr)); }
      .fk-grid > .fk-card > .fk-table-wrap { margin: 0 -4px; }
      .fk-card-subtitle { font-size: 12px; font-weight: 600; margin: 14px 0 8px; }
      .fk-ladder { list-style: none; margin: 0; padding: 0; }
      .fk-ladder-item { display: flex; gap: 9px; padding: 6px 0; align-items: flex-start; }
      .fk-ladder-mark { flex: none; width: 19px; height: 19px; border-radius: 50%; border: 1px solid var(--dsw-alias-border-l2); display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--dsw-alias-label-secondary); }
      .fk-ladder-done .fk-ladder-mark { background: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-bg-base); }
      .fk-ladder-current .fk-ladder-mark { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); box-shadow: 0 0 0 3px color-mix(in srgb, var(--dsw-alias-brand-primary) 18%, transparent); }
      .fk-ladder-title { font-size: 12px; font-weight: 500; }
      .fk-ladder-current .fk-ladder-title { color: var(--dsw-alias-brand-primary); }
      .fk-ladder-detail { color: var(--dsw-alias-label-secondary); font-size: 11px; margin-top: 1px; }
      .fk-chart svg { display: block; width: 100%; height: auto; }
      .fk-chart-empty { border: 1px dashed var(--dsw-alias-border-l2); border-radius: 9px; padding: 26px 18px; text-align: center; }
      .fk-chart-empty .fk-empty-title { font-size: 13px; }
      .fk-chart-empty .fk-empty-text { margin: 6px auto 0; font-size: 11.5px; }
      .fk-chart-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; margin-top: 4px; }
      .fk-table-wrap { overflow-x: auto; }
      .fk-table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
      .fk-table th { text-align: left; color: var(--dsw-alias-label-secondary); font-weight: 500; padding: 5px 7px; border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; }
      .fk-table td { padding: 5px 7px; border-bottom: 1px solid var(--dsw-alias-border-l1); white-space: nowrap; }
      .fk-table tr:last-child td { border-bottom: none; }
      .fk-row-best td { background: color-mix(in srgb, var(--dsw-alias-state-success-primary) 7%, transparent); }
      .fk-num { font-variant-numeric: tabular-nums; }
      .fk-up { color: var(--dsw-alias-state-success-primary); }
      .fk-down { color: var(--dsw-alias-state-error-primary); }
      .fk-fail { color: var(--dsw-alias-state-error-primary); }
      .fk-policy-rounds { color: var(--dsw-alias-label-secondary); font-size: 11px; margin-bottom: 8px; }
      .fk-arm { display: grid; grid-template-columns: 54px minmax(50px, 1fr) auto; gap: 8px; align-items: center; padding: 3px 0; font-size: 11.5px; }
      .fk-arm-name { color: var(--dsw-alias-label-primary); }
      .fk-arm-bar { height: 5px; border-radius: 99px; background: var(--dsw-alias-bg-layer-2); overflow: hidden; }
      .fk-arm-fill { height: 100%; border-radius: 99px; background: var(--dsw-alias-brand-primary); }
      .fk-arm-meta { color: var(--dsw-alias-label-secondary); font-size: 10.5px; text-align: right; white-space: nowrap; }
      .fk-notes { margin: 10px 0 0; padding-left: 17px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
      .fk-kb-counts { display: flex; gap: 12px; color: var(--dsw-alias-label-secondary); font-size: 11px; flex: none; }
      .fk-kb-card { margin-bottom: 14px; }
      .fk-kb-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
      .fk-kb-tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .fk-kb-kinds { display: flex; gap: 4px; }
      .fk-kb-filter { appearance: none; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); border-radius: 999px; padding: 3px 10px; font: inherit; font-size: 11px; cursor: pointer; }
      .fk-kb-filter:hover { background: var(--dsw-alias-bg-layer-2); }
      .fk-kb-filter-on { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-bg-base); }
      .fk-kb-search { background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; padding: 5px 9px; font: inherit; font-size: 12px; min-width: 190px; }
      .fk-kb-facets { display: flex; flex-wrap: wrap; gap: 5px; margin: 10px 0 2px; }
      .fk-kb-tag { appearance: none; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); border-radius: 999px; padding: 1px 8px; font: inherit; font-size: 10.5px; cursor: pointer; }
      .fk-kb-tag:hover { background: var(--dsw-alias-bg-layer-2); }
      .fk-kb-tag-on { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
      .fk-kb-scroll { max-height: 420px; overflow-y: auto; overscroll-behavior: contain; margin: 0 -4px; padding: 0 4px; }
      .fk-kb-scroll:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
      .fk-kb-list { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
      .fk-kb-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; margin-top: 8px; min-height: 16px; }
      .fk-kb-shown { color: var(--dsw-alias-label-secondary); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
      .fk-kb-hint { color: var(--dsw-alias-label-secondary); font-size: 11px; opacity: .8; }
      .fk-kb-sentinel { list-style: none; height: 1px; }
      .fk-kb-clear { appearance: none; border: 1px solid var(--dsw-alias-border-l1); background: transparent; color: var(--dsw-alias-label-secondary); border-radius: 6px; padding: 5px 9px; font: inherit; font-size: 11.5px; cursor: pointer; white-space: nowrap; }
      .fk-kb-clear:hover { background: var(--dsw-alias-bg-layer-2); }
      .fk-kb-item { padding: 9px 0; border-top: 1px solid var(--dsw-alias-border-l1); }
      .fk-kb-item-top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 10.5px; }
      .fk-kb-meta { color: var(--dsw-alias-label-secondary); }
      .fk-kb-when { margin-left: auto; color: var(--dsw-alias-label-secondary); }
      .fk-kb-item .fk-kb-text { white-space: normal; margin-top: 4px; font-size: 12px; }
      .fk-kb-item-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 5px; }
      .fk-kb-more { display: flex; justify-content: center; margin-top: 10px; }
      .fk-kb-conf { color: var(--dsw-alias-label-secondary); font-size: 10.5px; }
      .fk-readonly { margin-top: 10px; color: var(--dsw-alias-label-secondary); font-size: 11px; }
      .fk-kind { display: inline-block; text-align: center; border-radius: 4px; padding: 0 5px; font-size: 10px; border: 1px solid var(--dsw-alias-border-l1); }
      .fk-kind-pattern { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
      .fk-kind-antipattern { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
      .fk-kind-insight { color: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); }
      .fk-empty-card { border: 1px dashed var(--dsw-alias-border-l2); border-radius: 12px; padding: 28px 24px; text-align: center; margin-top: 22px; }
      .fk-empty-title { font-size: 15px; font-weight: 600; }
      .fk-empty-text { color: var(--dsw-alias-label-secondary); margin: 7px auto 16px; max-width: 560px; font-size: 12px; }
      .fk-empty-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: center; }
      .fk-empty { color: var(--dsw-alias-label-secondary); padding: 12px 0; font-size: 12px; }
      .fk-foot { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 18px; color: var(--dsw-alias-label-secondary); font-size: 10.5px; margin-top: 10px; word-break: break-all; }
      @media (max-width: 860px) {
        .fk-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .fk-grid, .fk-grid-2 { grid-template-columns: minmax(0, 1fr); }
        .fk-page { padding: 16px 14px 44px; }
      }
    `

    return {
      inject: ['slots', 'locale'],
      // Exposed so tests can render the page against stub hooks: a layout bug
      // in this component blanks the whole settings panel, which a source-level
      // assertion cannot catch.
      __components: { ForgePage, KnowledgeBrowser },
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'fathomkernel: dictionaries')
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'fathomkernel',
          order: 35,
          label: () => t('section.label'),
          locale: NS,
        }, ForgePage))
      },
    }
  },
})
