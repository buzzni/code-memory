/**
 * Code Memory Dashboard Logic
 * Handles state management, API calls, and UI updates.
 */

const API_BASE = '/api';

// State
const state = {
  stats: null,
  sharedStats: null,
  currentLevel: 'L0',
  events: [],
  isLoading: false,
  chartInstance: null
};

// Utils
const formatNumber = (num) => new Intl.NumberFormat().format(num || 0);

// Colors for Chart
const CHART_COLORS = {
  L0: '#7B61FF',
  L1: '#00F0FF',
  L2: '#00E396',
  L3: '#FEB019',
  L4: '#FF4560'
};

// --- Initialization ---

document.addEventListener('DOMContentLoaded', () => {
  initDashboard();
});

async function initDashboard() {
  await refreshData();
  setupEventListeners();
  initActivityChart();
}

function setupEventListeners() {
  // Navigation
  document.querySelectorAll('.p-step').forEach(step => {
    step.addEventListener('click', (e) => {
      const level = e.currentTarget.dataset.level;
      if (level) selectLevel(level);
    });
  });

  // Search
  const searchInput = document.getElementById('search-input');
  if (searchInput) {
    searchInput.addEventListener('input', debounce((e) => handleSearch(e.target.value), 300));
  }

  // Refresh
  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', refreshData);
  }
}

// --- Data Fetching ---

async function refreshData() {
  const btn = document.getElementById('refresh-btn');
  if(btn) btn.classList.add('loading');
  
  try {
    const [stats, shared] = await Promise.all([
      fetch(`${API_BASE}/stats`).then(r => r.json()).catch(() => null),
      fetch(`${API_BASE}/stats/shared`).then(r => r.json()).catch(() => null)
    ]);

    state.stats = stats;
    state.sharedStats = shared;

    updateStatsUI();
    updateSharedUI();
    await loadLevelEvents(state.currentLevel);
    
    // Update Endless Mode Status (Mocked if API missing)
    checkEndlessStatus();

  } catch (error) {
    console.error('Failed to refresh data:', error);
  } finally {
    if(btn) btn.classList.remove('loading');
  }
}

async function loadLevelEvents(level) {
  state.isLoading = true;
  updateEventsListUI(); // Show loading state

  try {
    // Determine API endpoint based on level
    // L0 -> /events, others might be filtered
    // For now, using the same pattern as original but adapted
    const response = await fetch(`${API_BASE}/events?level=${level}&limit=20`);
    if (response.ok) {
      const data = await response.json();
      state.events = data.events || [];
    } else {
      state.events = [];
    }
  } catch (error) {
    console.error(`Failed to load events for ${level}:`, error);
    state.events = [];
  } finally {
    state.isLoading = false;
    updateEventsListUI();
  }
}

// --- UI Updates ---

function updateStatsUI() {
  if (!state.stats) return;

  const { total_events, total_sessions, total_vectors } = state.stats;
  
  document.getElementById('stat-events').textContent = formatNumber(total_events);
  document.getElementById('stat-sessions').textContent = formatNumber(total_sessions);
  
  // Consolidating shared stats as a simple sum for the header if needed, 
  // or just using the shared object
  const sharedCount = state.sharedStats ? 
    (state.sharedStats.troubleshooting + state.sharedStats.best_practices + state.sharedStats.common_errors) : 0;
  
  document.getElementById('stat-shared').textContent = formatNumber(sharedCount);
  document.getElementById('stat-vectors').textContent = formatNumber(total_vectors);

  // Update Pipeline Counts (Mock logic as original didn't have per-level counts easily accessible in stats object usually)
  // If stats has level breakdown use that, otherwise distribute for visual
  updatePipelineCounts(state.stats.level_counts || {});
}

function updatePipelineCounts(counts) {
  document.querySelectorAll('.p-step').forEach(step => {
    const level = step.dataset.level;
    const countEl = step.querySelector('.p-step-count');
    // Default to 0 if not found
    countEl.textContent = formatNumber(counts[level] || 0);
  });
}

function updateSharedUI() {
  if (!state.sharedStats) return;
  
  document.getElementById('shared-troubleshooting').textContent = formatNumber(state.sharedStats.troubleshooting);
  document.getElementById('shared-best-practices').textContent = formatNumber(state.sharedStats.best_practices);
  document.getElementById('shared-errors').textContent = formatNumber(state.sharedStats.common_errors);
}

function selectLevel(level) {
  state.currentLevel = level;
  
  // Update Visuals
  document.querySelectorAll('.p-step').forEach(step => {
    step.classList.toggle('active', step.dataset.level === level);
  });
  
  loadLevelEvents(level);
}

function updateEventsListUI() {
  const container = document.getElementById('event-list-container');
  container.innerHTML = '';

  if (state.isLoading) {
    container.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-muted);">Loading events...</div>';
    return;
  }

  if (state.events.length === 0) {
    container.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-muted);">No events found for this level.</div>';
    return;
  }

  state.events.forEach(event => {
    const el = document.createElement('div');
    el.className = 'event-item';
    
    const time = new Date(event.timestamp).toLocaleString();
    const typeClass = `type-${event.type.toLowerCase().replace('_', '-')}`;
    
    el.innerHTML = `
      <div class="event-header">
        <span class="event-type-badge ${typeClass}">${event.type}</span>
        <span class="event-time">${time}</span>
      </div>
      <div class="event-content">${escapeHtml(event.content || '')}</div>
    `;
    
    container.appendChild(el);
  });
}

// --- Charts ---

function initActivityChart() {
  const chartEl = document.querySelector("#activity-chart");
  if (!chartEl) return;

  const options = {
    series: [{
      name: 'Events',
      data: [30, 40, 35, 50, 49, 60, 70, 91, 125] // Placeholder data, would populate from API
    }],
    chart: {
      type: 'area',
      height: 300,
      background: 'transparent',
      toolbar: { show: false },
      fontFamily: 'Outfit, sans-serif'
    },
    theme: { mode: 'dark' },
    stroke: {
      curve: 'smooth',
      width: 3,
      colors: [CHART_COLORS.L0]
    },
    fill: {
      type: 'gradient',
      gradient: {
        shadeIntensity: 1,
        opacityFrom: 0.7,
        opacityTo: 0.1,
        stops: [0, 90, 100]
      }
    },
    dataLabels: { enabled: false },
    grid: {
      borderColor: 'rgba(255,255,255,0.05)',
      strokeDashArray: 4,
    },
    xaxis: {
      categories: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep'], // Placeholder
      labels: { style: { colors: '#8B9BB4' } },
      axisBorder: { show: false },
      axisTicks: { show: false }
    },
    yaxis: {
      labels: { style: { colors: '#8B9BB4' } }
    },
    colors: [CHART_COLORS.L0]
  };

  state.chartInstance = new ApexCharts(chartEl, options);
  state.chartInstance.render();
}

// --- Endless Mode ---

async function checkEndlessStatus() {
  const statusEl = document.getElementById('status-dot');
  const textEl = document.getElementById('status-text');
  
  // Mock check - replace with real API if available
  // const isRunning = await fetch('/api/endless/status')... 
  const isRunning = false; 

  if (statusEl && textEl) {
    if (isRunning) {
      statusEl.classList.add('active');
      textEl.textContent = 'Active Background Processing';
      textEl.style.color = 'var(--success)';
    } else {
      statusEl.classList.remove('active');
      textEl.textContent = 'Idle';
      textEl.style.color = 'var(--text-muted)';
    }
  }
}

// --- Helpers ---

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

function handleSearch(query) {
  console.log('Searching for:', query);
  // Implement search logic here
}

function escapeHtml(unsafe) {
  return unsafe
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
