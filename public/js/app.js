// Select all checkbox
document.addEventListener("DOMContentLoaded", () => {
  const selectAll = document.getElementById("selectAll");
  if (selectAll) {
    selectAll.addEventListener("change", (e) => {
      document.querySelectorAll('input[name="ids"]').forEach((cb) => {
        cb.checked = e.target.checked;
      });
    });
  }
});
