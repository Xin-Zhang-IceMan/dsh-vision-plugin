/**
 * dsh-vision-plugin — CLIENT half (settings page, bilingual zh/en).
 *
 * Registers a "视觉模型 / Vision Model" page in the DSH settings panel (slot
 * `settings.section`):
 *  - shows only the CURRENT final version;
 *  - lets the user pick the default vision model (auto-select or one of the
 *    image-capable models on the deployment route) and save it;
 *  - all copy is localized through the DSH `locale` service and follows the
 *    active interface language automatically (Settings → General → Language),
 *    including the settings nav label.
 *
 * Talks to the Host half via the package-private RPCs `vision/get-state` and
 * `vision/set-model`. Paste this content verbatim as `code.client` alongside
 * `vision-plugin.js` as `code.host` in the same `cordis_define` call.
 */

return {
  inject: ['locale'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    const locale = ctx.get('locale')
    ctx.effect(() => styles.insert(`
      .dsh-vision-card { display: flex; flex-direction: column; gap: 14px; }
      .dsh-vision-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .dsh-vision-badge { font-size: 12px; padding: 2px 10px; border-radius: 999px; background: rgba(34,197,94,.15); color: #16a34a; border: 1px solid rgba(34,197,94,.35); }
      .dsh-vision-version { font-size: 12px; color: var(--dsh-text-2, #8b949e); }
      .dsh-vision-field { display: flex; flex-direction: column; gap: 6px; }
      .dsh-vision-field label { font-size: 13px; font-weight: 600; }
      .dsh-vision-field select { padding: 6px 10px; border-radius: 8px; border: 1px solid rgba(128,128,128,.35); background: transparent; color: inherit; font-size: 13px; max-width: 420px; }
      .dsh-vision-actions { display: flex; align-items: center; gap: 10px; }
      .dsh-vision-save { padding: 5px 16px; border-radius: 8px; border: none; background: #2563eb; color: #fff; font-size: 13px; cursor: pointer; }
      .dsh-vision-save:disabled { opacity: .55; cursor: default; }
      .dsh-vision-saved { font-size: 12px; color: #16a34a; }
      .dsh-vision-error { font-size: 12px; color: #ef4444; white-space: pre-wrap; }
      .dsh-vision-hint { font-size: 12px; color: var(--dsh-text-2, #8b949e); line-height: 1.6; }
      .dsh-vision-hint code { background: rgba(128,128,128,.15); padding: 0 4px; border-radius: 4px; }
    `))
    if (locale !== undefined) {
      ctx.effect(() => locale.register('vision', {
        zh: {
          settingsTitle: '视觉模型',
          badgeRunning: '● 运行中',
          versionLabel: 'v{version}',
          defaultModelLabel: '默认视觉模型',
          autoSelect: '自动选择（推荐）',
          autoWithDefault: '自动选择（{model}）',
          save: '保存',
          saving: '保存中…',
          saved: '✓ 已保存，立即生效',
          loading: '加载中…',
          loadFailed: '加载失败：{error}',
          current: '当前：{model} · 路由：{provider}',
          nativeVision: '原生视觉模型（图片直接发送，不转写）：{list}',
          hint: '纯文本模型收到图片时，由所选视觉模型自动转写为文字描述。',
        },
        en: {
          settingsTitle: 'Vision Model',
          badgeRunning: '● Running',
          versionLabel: 'v{version}',
          defaultModelLabel: 'Default vision model',
          autoSelect: 'Auto-select (recommended)',
          autoWithDefault: 'Auto-select ({model})',
          save: 'Save',
          saving: 'Saving…',
          saved: '✓ Saved, takes effect immediately',
          loading: 'Loading…',
          loadFailed: 'Load failed: {error}',
          current: 'Current: {model} · Route: {provider}',
          nativeVision: 'Native vision models (images sent directly, no translation): {list}',
          hint: 'When a text-only model receives an image, the selected vision model automatically transcribes it into text.',
        },
      }))
    }
    const t = locale === undefined ? (key) => key : locale.bind('vision')
    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'vision', order: 25, label: () => t('settingsTitle') },
      () => {
        const [state, setState] = React.useState(null)
        const [selected, setSelected] = React.useState('')
        const [saving, setSaving] = React.useState(false)
        const [saved, setSaved] = React.useState(false)
        const [error, setError] = React.useState(null)
        const [tick, setTick] = React.useState(0)
        React.useEffect(() => {
          if (locale === undefined) return undefined
          return locale.subscribe(() => setTick((v) => v + 1))
        }, [])
        React.useEffect(() => {
          let alive = true
          host.call('vision/get-state', {}).then((s) => {
            if (!alive) return
            setState(s)
            setSelected((s && s.configuredModel) || '')
          }).catch((e) => { if (alive) setError(String(e && e.message || e)) })
          return () => { alive = false }
        }, [])
        const save = () => {
          setSaving(true)
          setSaved(false)
          setError(null)
          host.call('vision/set-model', { model: selected || null }).then((s) => {
            setState(s)
            setSaving(false)
            setSaved(true)
          }).catch((e) => {
            setError(String(e && e.message || e))
            setSaving(false)
          })
        }
        if (state === null) {
          return React.createElement('div', { className: 'dsh-vision-card' },
            React.createElement('div', { className: 'dsh-vision-hint' }, error ? t('loadFailed', { error }) : t('loading')))
        }
        const visionModels = Array.isArray(state.models) ? state.models.filter((m) => m.image) : []
        const active = locale === undefined ? 'zh' : locale.getLocale().active
        const separator = active === 'zh' ? '、' : ', '
        const currentModel = state.configuredModel || t('autoWithDefault', { model: state.defaultModel })
        return React.createElement('div', { className: 'dsh-vision-card' },
          React.createElement('div', { className: 'dsh-vision-head' },
            React.createElement('span', { className: 'dsh-vision-badge' }, t('badgeRunning')),
            React.createElement('span', { className: 'dsh-vision-version' },
              t('versionLabel', { version: String(state.version) }))),
          React.createElement('div', { className: 'dsh-vision-field' },
            React.createElement('label', null, t('defaultModelLabel')),
            React.createElement('select', {
              value: selected,
              onChange: (e) => { setSelected(e.target.value); setSaved(false) },
              disabled: saving,
            },
              React.createElement('option', { value: '' }, t('autoSelect')),
              visionModels.map((m) =>
                React.createElement('option', { key: m.id, value: m.id }, m.id + (m.name && m.name !== m.id ? '（' + m.name + '）' : '')))),
            React.createElement('div', { className: 'dsh-vision-actions' },
              React.createElement('button', { className: 'dsh-vision-save', onClick: save, disabled: saving },
                saving ? t('saving') : t('save')),
              saved ? React.createElement('span', { className: 'dsh-vision-saved' }, t('saved')) : null,
              error ? React.createElement('span', { className: 'dsh-vision-error' }, error) : null)),
          React.createElement('div', { className: 'dsh-vision-hint' },
            React.createElement('div', null, t('current', { model: currentModel, provider: state.provider })),
            React.createElement('div', null, t('nativeVision', { list: Array.isArray(state.nativeVisionModels) ? state.nativeVisionModels.join(separator) : '' })),
            React.createElement('div', null, t('hint'))))
      },
    ))
  },
}
