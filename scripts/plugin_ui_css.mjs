/** Identical PostCSS isolation in Vite serve and build pipelines. */
export function scopedCss(scope = ".mison-ui", namespace = "mison") {
  return {
    postcssPlugin: "scoped-plugin-ui-css",
    OnceExit(root) {
      const keyframes = new Map()
      root.walkAtRules(/keyframes$/, (rule) => {
        keyframes.set(rule.params, namespace + "-" + rule.params)
        rule.params = namespace + "-" + rule.params
      })
      root.walkDecls((decl) => {
        if (!decl.prop.includes("animation") && !decl.prop.startsWith("--animate-")) return
        for (const [from, to] of keyframes)
          decl.value = decl.value.replace(new RegExp(`(?<![\\w-])${from}(?![\\w-])`, "g"), to)
      })
      root.walkRules((rule) => {
        for (let parent = rule.parent; parent; parent = parent.parent)
          if (
            parent.type === "rule" ||
            (parent.type === "atrule" && parent.name.endsWith("keyframes"))
          )
            return
        rule.selectors = rule.selectors.flatMap((selector) => {
          if (selector === ":root" || selector === ":host") return [scope]
          return [`:where(${scope}) ${selector}`]
        })
      })
    },
  }
}
