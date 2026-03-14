// Router - Hash-based SPA router with auth/role guards and dynamic page loading.
//
// Listens to `hashchange` events and renders the appropriate page template into
// `#page-container`. Enforces authentication and role-based access control before
// loading any protected page.
//
// Usage: call `initRouter()` after Alpine stores are initialized.

/**
 * Route definitions. Each key is a path pattern (may include `:param` segments).
 * - page:  filename in `pages/` without extension
 * - title: Vietnamese page title displayed in the header
 * - auth:  whether the route requires authentication
 * - roles: allowed roles (empty array = no role restriction)
 */
const routes = [
  { pattern: '/login',            page: 'login',      title: 'Đăng nhập',           auth: false, roles: [] },
  { pattern: '/dashboard',        page: 'dashboard',  title: 'Tổng quan',           auth: true,  roles: ['owner', 'manager', 'staff', 'cashier', 'warehouse'] },
  { pattern: '/tables',           page: 'table-map',  title: 'Sơ đồ bàn',           auth: true,  roles: ['owner', 'manager', 'staff', 'cashier'] },
  { pattern: '/orders/:tableId',  page: 'order',      title: 'Đặt món',             auth: true,  roles: ['owner', 'manager', 'staff', 'cashier'] },
  { pattern: '/order-list',       page: 'order-list', title: 'Danh sách đơn hàng',  auth: true,  roles: ['owner', 'manager'] },
  { pattern: '/bills/:orderId',   page: 'bill',       title: 'Hóa đơn',             auth: true,  roles: ['owner', 'manager', 'cashier'] },
  { pattern: '/bill-list',        page: 'bill-list',  title: 'Hóa đơn trong ngày',   auth: true,  roles: ['owner', 'manager', 'cashier'] },
  { pattern: '/menu/:id',         page: 'menu-edit',  title: 'Chỉnh sửa món ăn',    auth: true,  roles: ['owner', 'manager'] },
  { pattern: '/menu',             page: 'menu-list',  title: 'Quản lý thực đơn',     auth: true,  roles: ['owner', 'manager'] },
  { pattern: '/categories',       page: 'categories', title: 'Quản lý danh mục',     auth: true,  roles: ['owner', 'manager'] },
  { pattern: '/inventory',        page: 'inventory',  title: 'Quản lý tồn kho',      auth: true,  roles: ['owner', 'manager', 'warehouse'] },
  { pattern: '/ingredients',      page: 'ingredients', title: 'Quản lý nguyên liệu',  auth: true,  roles: ['owner', 'manager'] },
  { pattern: '/reports',          page: 'reports',    title: 'Báo cáo doanh thu',    auth: true,  roles: ['owner', 'manager'] },
  { pattern: '/users',            page: 'users',      title: 'Quản lý người dùng',   auth: true,  roles: ['owner', 'manager'] },
  { pattern: '/discounts',        page: 'discounts',  title: 'Quản lý khuyến mãi',  auth: true,  roles: ['owner', 'manager'] },
  { pattern: '/settings',         page: 'settings',   title: 'Cài đặt',             auth: true,  roles: ['owner', 'manager', 'cashier'] },
];

/**
 * Build a regex from a route pattern string.
 * Converts `:param` segments into named capture groups.
 *
 * Example: '/orders/:tableId' => /^\/orders\/([^/]+)$/
 * Returns { regex, paramNames } where paramNames lists the parameter names in order.
 */
function buildRouteRegex(pattern) {
  const paramNames = [];
  const regexStr = pattern.replace(/:([^/]+)/g, (_match, paramName) => {
    paramNames.push(paramName);
    return '([^/]+)';
  });
  return { regex: new RegExp('^' + regexStr + '$'), paramNames };
}

// Pre-compile route regexes at module load time for performance
const compiledRoutes = routes.map(route => ({
  ...route,
  ...buildRouteRegex(route.pattern),
}));

/**
 * Determine the default landing route for a given role.
 * Returns the pattern of the first auth-required, parameter-free route
 * that the role can access. Falls back to '/tables' if no match is found
 * (should not happen with correct route definitions).
 *
 * This prevents infinite redirect loops for roles like 'warehouse' that
 * cannot access '/tables'.
 *
 * @param {string|undefined} role - The user's role
 * @returns {string} The default route pattern (e.g., '/tables' or '/inventory')
 */
function getDefaultRoute(role) {
  if (!role) return '/login';
  // Owner/manager → dashboard; others → first accessible route
  if (role === 'owner' || role === 'manager') return '/dashboard';
  for (const route of routes) {
    // Skip login, skip routes with URL params (e.g., /orders/:tableId)
    if (!route.auth || route.pattern.includes(':')) continue;
    if (route.roles.length === 0 || route.roles.includes(role)) {
      return route.pattern;
    }
  }
  return '/tables';
}

/**
 * Match a hash path against the route definitions.
 * Returns the matched route config with extracted params, or null if no match.
 *
 * @param {string} path - The path portion of the hash (without '#')
 * @returns {{ page: string, title: string, auth: boolean, roles: string[], params: Object } | null}
 */
function matchRoute(path) {
  for (const route of compiledRoutes) {
    const match = path.match(route.regex);
    if (match) {
      const params = {};
      route.paramNames.forEach((name, index) => {
        params[name] = decodeURIComponent(match[index + 1]);
      });
      return {
        page: route.page,
        title: route.title,
        auth: route.auth,
        roles: route.roles,
        params,
      };
    }
  }
  return null;
}

/**
 * Load a page template from `pages/{pageName}.html` and inject it into
 * the `#page-container` element. Initializes Alpine directives on the
 * new content after injection.
 *
 * Shows loading state while fetching. On failure, displays an error message
 * in the content area.
 *
 * @param {string} pageName - Filename (without extension) in the pages/ directory
 * @param {Object} params - Route parameters (e.g., { tableId: '5' })
 */
async function loadPage(pageName, params) {
  const ui = Alpine.store('ui');
  const container = document.getElementById('page-container');

  if (!container) {
    console.error('[Router] #page-container element not found');
    return;
  }

  ui.startLoading('Đang tải...');

  try {
    const response = await fetch(`pages/${pageName}.html`);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const html = await response.text();
    container.innerHTML = html;

    // Store route params on the container so page components can access them
    container.dataset.routeParams = JSON.stringify(params);

    // Trigger page enter animation by re-adding the class
    container.classList.remove('page-container');
    void container.offsetWidth; // force reflow
    container.classList.add('page-container');

    // Re-initialize Alpine directives on the newly injected content
    Alpine.initTree(container);
  } catch (error) {
    console.error(`[Router] Failed to load page "${pageName}":`, error);
    container.innerHTML =
      '<div class="error-page" style="padding: 2rem; text-align: center;">' +
      '<p>Không thể tải trang</p>' +
      '</div>';
  } finally {
    ui.stopLoading();
  }
}

/**
 * Update the page title displayed in the header bar.
 * @param {string} title - The title text to display
 */
function updatePageTitle(title) {
  const titleEl = document.getElementById('page-title');
  if (titleEl) {
    titleEl.textContent = title;
  }
}

/**
 * The previous hash, tracked so the navigation guard can restore it
 * if the user cancels navigation while there are unsaved changes.
 * @type {string}
 */
let _previousHash = window.location.hash || '#/';

/**
 * Core routing handler. Called on every `hashchange` event and on initial load.
 * Performs auth guard, role guard, route matching, and page loading in sequence.
 *
 * Includes an unsaved-changes navigation guard: if the tableMap store has
 * unsaved changes (edit mode with pending layout modifications), the user is
 * prompted with a confirmation dialog before navigating away from the table map.
 * Requirements: 5.1 EC-3, 6.1 AC-5
 */
function handleRoute() {
  const hash = window.location.hash.slice(1) || '/';
  const auth = Alpine.store('auth');
  const userRole = auth.user?.role;
  const defaultRoute = '#' + getDefaultRoute(userRole);

  // --- Generic unsaved changes navigation guard ---
  // Check current page component for isDirty flag or tableMapStore.hasUnsavedChanges
  let isDirty = false;
  const pageContainer = document.getElementById('page-container');
  if (pageContainer) {
    const alpineRoot = pageContainer.querySelector('[x-data]');
    if (alpineRoot && alpineRoot._x_dataStack) {
      const pageData = alpineRoot._x_dataStack[0];
      if (pageData && pageData.isDirty) isDirty = true;
    }
  }
  // Also check tableMap store for backward compat
  const tableMapStore = Alpine.store('tableMap');
  if (tableMapStore && tableMapStore.hasUnsavedChanges) isDirty = true;

  if (isDirty) {
    const previousPath = _previousHash.slice(1) || '/';
    if (previousPath !== hash) {
      const confirmed = window.confirm(
        'Bạn có thay đổi chưa lưu. Bạn có muốn rời đi?',
      );
      if (!confirmed) {
        window.removeEventListener('hashchange', handleRoute);
        window.location.hash = _previousHash;
        window.addEventListener('hashchange', handleRoute);
        return;
      }
      // Try to call exitEditMode if available
      if (pageContainer) {
        const alpineRoot = pageContainer.querySelector('[x-data]');
        if (alpineRoot && alpineRoot._x_dataStack) {
          const pageData = alpineRoot._x_dataStack[0];
          if (pageData && typeof pageData.exitEditMode === 'function') {
            pageData.exitEditMode();
          }
        }
      }
    }
  }

  // Update previous hash tracker for the next navigation event
  _previousHash = window.location.hash || '#/';

  // Default route: empty hash or root redirects to role-appropriate landing page
  if (hash === '/' || hash === '') {
    window.location.hash = defaultRoute;
    return;
  }

  // Auth guard: unauthenticated users must go to /login
  if (!auth.isAuthenticated && hash !== '/login') {
    window.location.hash = '#/login';
    return;
  }

  // Auth guard: authenticated users on /login are redirected to landing page
  if (auth.isAuthenticated && hash === '/login') {
    window.location.hash = defaultRoute;
    return;
  }

  // Match the current hash against route definitions
  const matched = matchRoute(hash);

  if (!matched) {
    // Unknown route: redirect to landing page (or /login if not authenticated)
    window.location.hash = auth.isAuthenticated ? defaultRoute : '#/login';
    return;
  }

  // Role guard: check if the user's role is allowed for this route
  if (matched.roles.length > 0 && !matched.roles.includes(userRole)) {
    Alpine.store('ui').showToast('Bạn không có quyền truy cập trang này', 'error');
    window.location.hash = defaultRoute;
    return;
  }

  // Update page title in the header
  updatePageTitle(matched.title);

  // Update reactive hash for nav highlighting
  Alpine.store('ui').currentHash = window.location.hash;

  // Load the page template
  loadPage(matched.page, matched.params);
}

/**
 * Initialize the router. Registers the `hashchange` listener and processes
 * the initial route. Must be called after Alpine stores are registered and
 * auth state is resolved.
 */
export function initRouter() {
  window.addEventListener('hashchange', handleRoute);
  handleRoute();
}
