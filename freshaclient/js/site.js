// =============================================================================
// Fresha client app - reference wireframe
// -----------------------------------------------------------------------------
// Small jQuery-based interactions for the static HTML wireframe only.
// There is no backend here - nothing is saved, nothing is validated for real.
// =============================================================================

$(function () {

  // Date pills (Select date and time): clicking marks a pill active.
  $('.fr-date-pill').on('click', function (e) {
    if ($(this).hasClass('disabled')) { e.preventDefault(); return; }
    $(this).addClass('active').siblings('.fr-date-pill').removeClass('active');
  });

  // Time slots: clicking marks a slot active.
  $('.fr-time-slot').on('click', function (e) {
    e.preventDefault();
    $(this).addClass('active').siblings('.fr-time-slot').removeClass('active');
  });

  // Service "+" / checkmark toggle buttons on Select services pages.
  $('.fr-add-btn').on('click', function () {
    $(this).toggleClass('active');
    var $icon = $(this).find('i');
    if ($(this).hasClass('active')) {
      $icon.removeClass('bi-plus-circle').addClass('bi-check-circle-fill');
    } else {
      $icon.removeClass('bi-check-circle-fill').addClass('bi-plus-circle');
    }
  });

  // Heart / favourite toggle buttons on venue cards.
  $('.fr-heart-btn').on('click', function (e) {
    e.preventDefault();
    $(this).find('i').toggleClass('bi-heart bi-heart-fill');
  });

});
