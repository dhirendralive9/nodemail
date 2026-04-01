document.addEventListener("DOMContentLoaded", () => {
  // Select all checkbox
  const selectAll = document.getElementById("selectAll");
  if (selectAll) {
    selectAll.addEventListener("change", (e) => {
      document.querySelectorAll('input[name="ids"]').forEach((cb) => {
        cb.checked = e.target.checked;
      });
    });
  }
});

// Sidebar toggle for mobile
function toggleSidebar() {
  document.getElementById("sidebar").classList.toggle("open");
  document.getElementById("sidebarOverlay").classList.toggle("open");
}
