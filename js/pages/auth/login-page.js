// Login Page - Login form x-data component
//
// Alpine.js component for the login page. Manages form state (email, password,
// error, loading) and delegates authentication to the auth store.

/**
 * Alpine component factory for the login page.
 * Used as x-data="loginPage()" in pages/login.html.
 *
 * @returns {Object} Alpine component data object
 */
export function loginPage() {
  return {
    email: '',
    password: '',
    error: '',
    isLoading: false,

    /**
     * Handle login form submission.
     * Calls Alpine.store('auth').login() and handles errors with Vietnamese messages.
     */
    async login() {
      // Clear previous error
      this.error = '';

      // Basic client-side validation
      if (!this.email || !this.password) {
        this.error = 'Vui lòng nhập email và mật khẩu';
        return;
      }

      this.isLoading = true;

      try {
        await Alpine.store('auth').login(this.email, this.password);
      } catch (err) {
        // Auth service returns Vietnamese error messages
        this.error = err.message || 'Đã có lỗi xảy ra. Vui lòng thử lại.';
      } finally {
        this.isLoading = false;
      }
    },
  };
}

// Register as global function so x-data="loginPage()" works
// when the template is dynamically loaded by the router
window.loginPage = loginPage;
