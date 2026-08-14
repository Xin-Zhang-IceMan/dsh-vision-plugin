/**
 * dsh-vision-plugin — CLIENT half (settings page).
 *
 * Registers a "视觉模型" page in the DSH settings panel (slot `settings.section`):
 *  - shows only the CURRENT final version (no version history);
 *  - lets the user pick the default vision model (auto-select or one of the
 *    image-capable models on the deployment route) and save it;
 *  - talks to the Host half via the package-private RPCs `vision/get-state`
 *    and `vision/set-model`.
 *
 * Paste this content verbatim as `code.client` alongside `vision-plugin.js`
 * as `code.host` in the same `cordis_define` call.
 */

return {
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    const disposeStyle = styles.insert(`
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
    `)
    slots.inject('settings.section', () => slots.register(
      { name: 'settings.section', id: 'vision', order: 25, label: '视觉模型' },
      () => {
        const [state, setState] = React.useState(null)
        const [selected, setSelected] = React.useState('')
        const [saving, setSaving] = React.useState(false)
        const [saved, setSaved] = React.useState(false)
        const [error, setError] = React.useState(null)
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
            React.createElement('div', { className: 'dsh-vision-hint' }, error ? '加载失败：' + error : '加载中…'))
        }
        const visionModels = Array.isArray(state.models) ? state.models.filter((m) => m.image) : []
        return React.createElement('div', { className: 'dsh-vision-card' },
          React.createElement('div', { className: 'dsh-vision-head' },
            React.createElement('span', { className: 'dsh-vision-badge' }, '● 运行中'),
            React.createElement('span', { className: 'dsh-vision-version' },
              'v' + String(state.version) + ' · 当前版本（仅保留最终版）')),
          React.createElement('div', { className: 'dsh-vision-field' },
            React.createElement('label', null, '默认视觉模型'),
            React.createElement('select', {
              value: selected,
              onChange: (e) => { setSelected(e.target.value); setSaved(false) },
              disabled: saving,
            },
              React.createElement('option', { value: '' }, '自动选择（推荐）'),
              visionModels.map((m) =>
                React.createElement('option', { key: m.id, value: m.id }, m.id + (m.name && m.name !== m.id ? '（' + m.name + '）' : '')))),
            React.createElement('div', { className: 'dsh-vision-actions' },
              React.createElement('button', { className: 'dsh-vision-save', onClick: save, disabled: saving },
                saving ? '保存中…' : '保存'),
              saved ? React.createElement('span', { className: 'dsh-vision-saved' }, '✓ 已保存，立即生效') : null,
              error ? React.createElement('span', { className: 'dsh-vision-error' }, error) : null)),
          React.createElement('div', { className: 'dsh-vision-hint' },
            React.createElement('div', null, '当前：' + (state.configuredModel || '自动选择（' + state.defaultModel + '）') + ' · 路由：' + state.provider),
            React.createElement('div', null, '原生视觉模型（图片直接发送，不转写）：' + (Array.isArray(state.nativeVisionModels) ? state.nativeVisionModels.join('、') : '')),
            React.createElement('div', null, '纯文本模型收到图片时，由所选视觉模型自动转写为文字描述。')))
      },
    ))
    return disposeStyle
  },
}
