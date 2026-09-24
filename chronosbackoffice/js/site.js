// =============================================================================
// byChronos BackOffice - staff/admin wireframe
// -----------------------------------------------------------------------------
// Small jQuery-based interactions for the static HTML wireframe only.
// There is no backend here - nothing is saved, nothing is validated for real.
// =============================================================================

$(function () {

  // Show / hide password on the login page.
  $('.ad-toggle-password').on('click', function (e) {
    e.preventDefault();
    var $input = $($(this).data('target'));
    var isPassword = $input.attr('type') === 'password';
    $input.attr('type', isPassword ? 'text' : 'password');
    $(this).find('i').toggleClass('bi-eye bi-eye-slash');
  });

  // "Days to preview" pill toggle (Today / 7 days / 30 days) - visual only.
  $('.ad-days-toggle .btn').on('click', function () {
    $(this).addClass('btn-ad').removeClass('btn-ad-outline')
      .siblings().removeClass('btn-ad').addClass('btn-ad-outline');
  });

  // Scroll-to-top button.
  $('.ad-scrolltop').on('click', function () {
    $('html, body').animate({ scrollTop: 0 }, 200);
  });

});
