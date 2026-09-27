/**
 * CEOVA CCTV // Ceova Ecosystem Client Controller
 * public/js/ceova_ecosystem.js
 * 
 * Manages Ceova Main App ecosystem session, organization entitlements,
 * camera quota badges, and SSO handshake status.
 */

(function () {
  'use strict';

  class CeovaEcosystemController {
    constructor() {
      this.state = {
        authenticated: false,
        organizationId: null,
        userId: null,
        plan: 'starter',
        entitlements: { max_cameras: 5, analytics: false, reports: false },
        cameraUsage: { current: 0, max: 5 },
        status: 'DISCONNECTED'
      };

      this.init();
    }

    async init() {
      // 1. Check if an SSO token is in query params
      const urlParams = new URLSearchParams(window.location.search);
      const token = urlParams.get('token');
      if (token && window.location.pathname !== '/auth/sso') {
        await this.exchangeToken(token);
        // Clean URL
        window.history.replaceState({}, document.title, window.location.pathname);
      }

      // 2. Fetch current session & organization profile
      await this.refreshSession();
      this.renderEcosystemBar();
    }

    async refreshSession() {
      try {
        const res = await fetch('/api/auth/me');
        if (res.ok) {
          const data = await res.json();
          this.state = {
            authenticated: data.authenticated,
            organizationId: data.organization_id,
            userId: data.user_id,
            plan: data.plan,
            entitlements: data.entitlements,
            cameraUsage: data.camera_usage,
            status: data.status
          };
        } else {
          this.state.authenticated = false;
        }
      } catch (err) {
        console.warn('[CeovaEcosystem] Failed to fetch auth status:', err);
        this.state.authenticated = false;
      }
    }

    async exchangeToken(token) {
      try {
        const res = await fetch('/api/auth/sso/exchange', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token })
        });
        if (res.ok) {
          const data = await res.json();
          // Set cookie for session
          document.cookie = `ceova_cctv_session=${data.session_token}; Path=/; SameSite=Lax; Max-Age=604800`;
          await this.refreshSession();
        }
      } catch (err) {
        console.error('[CeovaEcosystem] Token exchange failed:', err);
      }
    }

    renderEcosystemBar() {
      let existingBar = document.getElementById('ceovaEcosystemBar');
      if (!existingBar) {
        existingBar = document.createElement('div');
        existingBar.id = 'ceovaEcosystemBar';
        existingBar.className = 'ceova-ecosystem-bar';
        document.body.insertBefore(existingBar, document.body.firstChild);
      }

      const planClass = (this.state.plan || 'starter').toLowerCase();
      const currentCams = this.state.cameraUsage?.current || 0;
      const maxCams = this.state.cameraUsage?.max || 5;
      const fillPercent = Math.min(100, Math.round((currentCams / maxCams) * 100));

      existingBar.innerHTML = `
        <div class="ceova-ecosystem-left">
          <div class="ceova-badge-tag">
            <span class="pulse-dot"></span>
            CEOVA ECOSYSTEM
          </div>
          <div class="ceova-meta-item">
            <span>Org:</span>
            <strong>${this.state.organizationId || 'Not Paired'}</strong>
          </div>
          <span class="ceova-plan-pill ${planClass}">
            ${(this.state.plan || 'STARTER').toUpperCase()} PLAN
          </span>
          <div class="ceova-meta-item">
            <span>Analytics:</span>
            <strong style="color: ${this.state.entitlements.analytics ? '#10b981' : '#94a3b8'}">
              ${this.state.entitlements.analytics ? 'ENABLED' : 'DISABLED'}
            </strong>
          </div>
        </div>

        <div class="ceova-ecosystem-right">
          <div class="ceova-quota-meter">
            <span>Cameras: <strong>${currentCams} / ${maxCams}</strong></span>
            <div class="ceova-quota-bar-bg" title="${currentCams} of ${maxCams} camera slots used">
              <div class="ceova-quota-bar-fill" style="width: ${fillPercent}%;"></div>
            </div>
          </div>

          <button class="ceova-btn-sm" id="btnCeovaManage" title="Manage pairing and ecosystem profile">
            ⚙️ Ecosystem
          </button>
        </div>
      `;

      document.getElementById('btnCeovaManage')?.addEventListener('click', () => {
        this.openPairingModal();
      });
    }

    openPairingModal() {
      let modal = document.getElementById('ceovaPairModal');
      if (modal) modal.remove();

      modal = document.createElement('div');
      modal.id = 'ceovaPairModal';
      modal.className = 'ceova-pair-modal-overlay';

      modal.innerHTML = `
        <div class="ceova-pair-modal-box">
          <div class="ceova-pair-modal-header">
            <div>
              <h3>Ceova Ecosystem Integration</h3>
              <p>Ceova CCTV connects directly with Ceova Main App via private internal API protocol.</p>
            </div>
          </div>

          <div class="ceova-pair-options">
            <div class="ceova-pair-card">
              <h4>Current Paired Context</h4>
              <p>Organization: <strong>${this.state.organizationId || 'None'}</strong> | Plan: <strong>${this.state.plan}</strong></p>
              <p>User ID: <strong>${this.state.userId || 'local-console'}</strong> | Max Cameras: <strong>${this.state.entitlements.max_cameras}</strong></p>
            </div>

            <div class="ceova-pair-card">
              <h4>Switch Plan & Entitlements (Test Simulation)</h4>
              <p>Simulate Ceova Main subscription upgrade to test quota and feature gates:</p>
              <div class="ceova-btn-preset-group">
                <button class="ceova-btn-preset" data-plan="starter">Starter (5 Cams)</button>
                <button class="ceova-btn-preset" data-plan="professional">Professional (16 Cams)</button>
                <button class="ceova-btn-preset" data-plan="enterprise">Enterprise (50 Cams)</button>
              </div>
            </div>

            <div class="ceova-pair-card">
              <h4>Launch Token / Manual Handshake</h4>
              <p>Enter an SSO launch token generated by Ceova Main App:</p>
              <input type="text" class="ceova-input-field" id="inputLaunchToken" placeholder="lnch_..." />
              <button class="ceova-btn-primary" id="btnExchangeLaunchToken">Exchange Token & Log In</button>
            </div>
          </div>

          <div style="display:flex; justify-content:flex-end;">
            <button class="ceova-btn-sm" id="btnClosePairModal">Close</button>
          </div>
        </div>
      `;

      document.body.appendChild(modal);

      // Event listeners
      document.getElementById('btnClosePairModal')?.addEventListener('click', () => modal.remove());
      modal.addEventListener('click', (e) => {
        if (e.target === modal) modal.remove();
      });

      // Preset buttons for simulating plan upgrades
      modal.querySelectorAll('.ceova-btn-preset').forEach(btn => {
        btn.addEventListener('click', async () => {
          const selectedPlan = btn.getAttribute('data-plan');
          await this.simulatePlanChange(selectedPlan);
          modal.remove();
        });
      });

      // Token exchange
      document.getElementById('btnExchangeLaunchToken')?.addEventListener('click', async () => {
        const tokenInput = document.getElementById('inputLaunchToken')?.value.trim();
        if (tokenInput) {
          await this.exchangeToken(tokenInput);
          modal.remove();
          this.renderEcosystemBar();
        }
      });
    }

    async simulatePlanChange(plan) {
      try {
        const orgId = this.state.organizationId || 'org_71A92';
        const maxCams = plan === 'enterprise' ? 50 : (plan === 'professional' ? 16 : 5);
        
        // Internal pairing call to update plan
        const res = await fetch('/api/v1/internal/pair', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Ceova-Internal-Key': 'ceova-internal-secret-production-key-2026'
          },
          body: JSON.stringify({
            ceova_user_id: this.state.userId || 'usr_82X91',
            organization_id: orgId,
            plan,
            entitlements: {
              max_cameras: maxCams,
              analytics: plan !== 'starter',
              reports: plan !== 'starter',
              ai_query: true
            }
          })
        });

        if (res.ok) {
          await this.refreshSession();
          this.renderEcosystemBar();
        }
      } catch (err) {
        console.error('Failed to change plan:', err);
      }
    }
  }

  // Auto-instantiate on load
  window.addEventListener('DOMContentLoaded', () => {
    window.ceovaEcosystem = new CeovaEcosystemController();
  });
})();
