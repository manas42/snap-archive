/**
 * 路由前缀的单一来源。
 *
 * 前端 index.html 与后端 impl.mjs 都从这里取端点，任何文件都不得手写
 * 路由字面量 —— 改前缀只改这一个文件（否则前后端漂移会直接 404）。
 */

/**
 * 路由前缀。独立服务监听自己的端口，所以是空串（页面在 `/`，API 在 `/api/*`）。
 * 若将来要改挂到别的路径下（例如作为 DSH 插件复用 DSH 端口），只改这一个值。
 */

/** 插件认领的前缀；空前缀表示"服务自己的根"。 */
export const ROUTE_PREFIX = ''

/** API 端点前缀。 */
export const API_BASE = `${ROUTE_PREFIX}/api`

/** 媒体字节端点前缀（原图 / 原视频，支持 Range）。 */
export const MEDIA_BASE = `${ROUTE_PREFIX}/media`

/** UI 页面路径（非 API 前缀）。 */
export const UI_PATH = `${ROUTE_PREFIX}/`
