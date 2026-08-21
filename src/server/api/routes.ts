/**
 * REST for boards, columns and cards.
 *
 * Every mutation publishes on the SSE stream, so an interface never has to
 * poll and a second tab stays correct. Validation failures name the field, so
 * the interface can put the message where the operator is looking rather than
 * showing a bare 400.
 *
 * The routes themselves live one module per resource. This file is the seam
 * app.ts binds to, so adding a module does not change the wiring and moving a
 * route between modules is invisible outside this directory.
 */

export { registerApiRoutes } from './board-routes.js';
export { registerDispatchRoutes } from './dispatch-routes.js';
export { registerPlanRoutes } from './plan-routes.js';
export { registerBindingRoutes } from './binding-routes.js';
export { registerCardDetailRoutes } from './card-detail-routes.js';
export { registerTimelineRoutes } from './timeline-routes.js';
export { registerReviewRoutes } from './review-routes.js';
export { registerBriefRoutes, type ExtractionState } from './brief-routes.js';
