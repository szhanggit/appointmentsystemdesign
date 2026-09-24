// =============================================================================
// Selah Head Spa - byChronos CLIENT-FACING wireframe
// -----------------------------------------------------------------------------
// Small jQuery-based interactions for the static HTML wireframe only.
// There is no backend here - nothing is saved, nothing is validated for real.
// Real behavior (API calls, validation, state) gets built later.
// =============================================================================

$(function () {

  // Show / hide password fields on the Create account page.
  $('.bc-toggle-password').on('click', function (e) {
    e.preventDefault();
    var $input = $($(this).data('target'));
    var isPassword = $input.attr('type') === 'password';
    $input.attr('type', isPassword ? 'text' : 'password');
    $(this).text(isPassword ? 'Hide' : 'Show');
  });

  // Category pill tabs: clicking marks the clicked tab active (visual only,
  // does not actually filter the service list in this wireframe).
  $('.bc-category-tabs').on('click', '.btn', function () {
    $(this).addClass('btn-brand').removeClass('btn-outline-secondary')
      .siblings().addClass('btn-outline-secondary').removeClass('btn-brand');
  });

  // Left/right arrow buttons scroll the category tab row.
  $('.bc-tabs-prev').on('click', function () {
    $('.bc-category-tabs').animate({ scrollLeft: '-=150' }, 150);
  });
  $('.bc-tabs-next').on('click', function () {
    $('.bc-category-tabs').animate({ scrollLeft: '+=150' }, 150);
  });

  // Service "+" buttons toggle to a checkmark and (de)select the card.
  $('.bc-add-btn').on('click', function () {
    $(this).toggleClass('selected');
    $(this).closest('.bc-service-card').toggleClass('selected');
    var $icon = $(this).find('i');
    if ($(this).hasClass('selected')) {
      $icon.removeClass('bi-plus').addClass('bi-check-lg');
    } else {
      $icon.removeClass('bi-check-lg').addClass('bi-plus');
    }
  });

  // Collapsible guest blocks in the right-hand summary panel.
  $('.bc-guest-title').on('click', function () {
    $(this).closest('.bc-guest-block').find('.bc-guest-body').slideToggle(150);
    $(this).find('.bi').toggleClass('bi-chevron-up bi-chevron-down');
  });

  // Reschedule flow: picking any sample time slot in the "pick a new time"
  // modal swaps to the "here is your new time" confirmation modal.
  $('.bc-reschedule-slot').on('click', function () {
    var modalEl = $(this).closest('.modal')[0];
    if (modalEl) {
      var pickerModal = bootstrap.Modal.getOrCreateInstance(modalEl);
      pickerModal.hide();
    }
    var confirmEl = document.getElementById('rescheduleConfirmModal');
    if (confirmEl) {
      bootstrap.Modal.getOrCreateInstance(confirmEl).show();
    }
  });

});
