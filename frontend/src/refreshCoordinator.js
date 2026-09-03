/**
 * 刷新协调器：把「一次全量拉取」包装成可并发调用的任务，解决两类真实问题。
 *
 * 1) sync()：只保证「有一次刷新在跑/刚跑完」。挂载与离线自动重试用它 ——
 *    React StrictMode 会双调用挂载 effect，这里搭同一班车，不会白打两遍接口。
 * 2) refresh()：数据已经改了（删除 / 审核 / 发布 / 导入）之后的刷新。若恰好有刷新在跑，
 *    先等它结束**再补一轮**。老实现的 `if (refreshing) return true` 会直接返回，
 *    而在跑的那一轮很可能是在本次变更**之前**发出的 —— 界面就会停在变更前的样子。
 *
 * 不做无限递归：每个调用者最多触发一轮尾随刷新，并发 N 个调用 → 最多 2 轮。
 */
export function createRefreshCoordinator(initialTask) {
  let task = initialTask
  let running = null
  let pending = false

  async function pass() {
    // 用 Promise.resolve().then 包住，保证 running 在任何 await 之前就被赋值（同步占位）
    const current = task
    const p = Promise.resolve().then(() => current())
    running = p
    try {
      return await p
    } finally {
      if (running === p) running = null
    }
  }

  return {
    /** 换用新的任务体（组件里传进来的函数身份可能随渲染变化） */
    setTask(next) {
      task = next
    },

    async sync() {
      if (running) return running
      return pass()
    },

    async refresh() {
      if (running) {
        pending = true
        await running
        if (pending) {
          pending = false
          return pass()
        }
        return true // 期间已有别人补过一轮，本次不必再打
      }
      pending = false
      return pass()
    },

    /** 只读观察：当前是否有刷新在飞（测试与调试用） */
    get busy() {
      return running !== null
    },
  }
}
