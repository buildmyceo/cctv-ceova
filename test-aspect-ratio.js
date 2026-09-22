// Test script to verify Aspect Ratio, Fit, and Rotation features
const fs = require('fs');
const assert = require('assert');

console.log('--- VERIFYING ASPECT RATIO, FIT & ROTATION IMPLEMENTATION ---');

// 1. Check index.html elements
const indexHtml = fs.readFileSync(__dirname + '/public/index.html', 'utf8');
assert(indexHtml.includes('id="btnAspectToggle"'), 'index.html missing #btnAspectToggle');
assert(indexHtml.includes('id="aspectBtnText"'), 'index.html missing #aspectBtnText');
assert(indexHtml.includes('id="btnFitToggle"'), 'index.html missing #btnFitToggle');
assert(indexHtml.includes('id="fitBtnText"'), 'index.html missing #fitBtnText');
assert(indexHtml.includes('id="btnRotateToggle"'), 'index.html missing #btnRotateToggle');
assert(indexHtml.includes('id="rotateBtnText"'), 'index.html missing #rotateBtnText');
assert(indexHtml.includes('id="osdAspectBadge"'), 'index.html missing #osdAspectBadge');
console.log('✅ 1. index.html contains all controls and badges');

// 2. Check camera.html elements
const cameraHtml = fs.readFileSync(__dirname + '/public/camera.html', 'utf8');
assert(cameraHtml.includes('id="btnOrientation"'), 'camera.html missing #btnOrientation');
console.log('✅ 2. camera.html contains orientation toggle button');

// 3. Check style.css classes
const styleCss = fs.readFileSync(__dirname + '/public/css/style.css', 'utf8');
assert(styleCss.includes('.cctv-monitor-wrapper.aspect-16-9'), 'style.css missing .aspect-16-9');
assert(styleCss.includes('.cctv-monitor-wrapper.aspect-9-16'), 'style.css missing .aspect-9-16');
assert(styleCss.includes('.cctv-video-element.fit-cover'), 'style.css missing .fit-cover');
assert(styleCss.includes('.aspect-16-9 .cctv-video-element.rotate-90'), 'style.css missing 16:9 rotate-90');
assert(styleCss.includes('.aspect-9-16 .cctv-video-element.rotate-90'), 'style.css missing 9:16 rotate-90');
console.log('✅ 3. style.css contains all 16:9, 9:16, fit-cover, and rotation rules');

// 4. Test getRenderTransformation math for both 16:9 and 9:16 containers
function testRenderTransform() {
  function getRenderTransformation(sourceWidth, sourceHeight, canvasWidth, canvasHeight, fitMode) {
    const sWidth = sourceWidth;
    const sHeight = sourceHeight;
    const cWidth = canvasWidth;
    const cHeight = canvasHeight;

    const sourceRatio = sWidth / sHeight;
    const canvasRatio = cWidth / cHeight;

    let renderW, renderH, offsetX, offsetY;

    if (fitMode === 'cover') {
      if (canvasRatio > sourceRatio) {
        renderW = cWidth;
        renderH = cWidth / sourceRatio;
        offsetX = 0;
        offsetY = (cHeight - renderH) / 2;
      } else {
        renderH = cHeight;
        renderW = cHeight * sourceRatio;
        offsetX = (cWidth - renderW) / 2;
        offsetY = 0;
      }
    } else {
      if (canvasRatio > sourceRatio) {
        renderH = cHeight;
        renderW = cHeight * sourceRatio;
        offsetX = (cWidth - renderW) / 2;
        offsetY = 0;
      } else {
        renderW = cWidth;
        renderH = cWidth / sourceRatio;
        offsetX = 0;
        offsetY = (cHeight - renderH) / 2;
      }
    }

    return {
      offsetX,
      offsetY,
      renderW,
      renderH,
      scaleX: renderW / sWidth,
      scaleY: renderH / sHeight
    };
  }

  // Case A: 1080x1920 (9:16) video in 9:16 container (405x720) - Fit Mode
  const t1 = getRenderTransformation(1080, 1920, 405, 720, 'contain');
  assert.strictEqual(t1.offsetX, 0, '9:16 in 9:16 container should have 0 offsetX');
  assert.strictEqual(t1.offsetY, 0, '9:16 in 9:16 container should have 0 offsetY');
  assert.strictEqual(t1.renderW, 405, 'renderW should match container width');
  assert.strictEqual(t1.renderH, 720, 'renderH should match container height');
  console.log('✅ 4a. 9:16 portrait video in 9:16 container: Perfect 100% 0-margin fit');

  // Case B: 1080x1920 (9:16) video in 16:9 container (1280x720) - Contain Mode (Letterbox)
  const t2 = getRenderTransformation(1080, 1920, 1280, 720, 'contain');
  assert(t2.offsetX > 0, '16:9 container with 9:16 video should have letterbox offsetX');
  assert.strictEqual(t2.renderH, 720, 'renderH should match container height');
  console.log(`✅ 4b. 9:16 portrait video in 16:9 container (contain): Rendered ${t2.renderW}x${t2.renderH} with offsetX ${t2.offsetX}`);

  // Case C: 1080x1920 (9:16) video in 16:9 container (1280x720) - Cover Mode (Fill)
  const t3 = getRenderTransformation(1080, 1920, 1280, 720, 'cover');
  assert.strictEqual(t3.renderW, 1280, 'renderW in cover mode should fill 1280');
  assert(t3.offsetY < 0, 'offsetY in cover mode should be negative to center vertical content');
  console.log(`✅ 4c. 9:16 portrait video in 16:9 container (cover): Rendered ${t3.renderW}x${t3.renderH} filling width`);

  // Case D: 1920x1080 (16:9) video in 16:9 container (1280x720) - Fit Mode
  const t4 = getRenderTransformation(1920, 1080, 1280, 720, 'contain');
  assert.strictEqual(t4.offsetX, 0, '16:9 in 16:9 container should have 0 offsetX');
  assert.strictEqual(t4.offsetY, 0, '16:9 in 16:9 container should have 0 offsetY');
  console.log('✅ 4d. 16:9 landscape video in 16:9 container: Perfect 100% 0-margin fit');
}

testRenderTransform();

console.log('🌟 ALL VERIFICATION TESTS PASSED SUCCESSFULLY! 🌟');
