const sensorNameInput = document.getElementById("sensor-name");

const bufferInputs = [1, 2, 3].map(n =>
  document.getElementById(`buffer-${n}`)
);

const captureButtons = [1, 2, 3].map(n =>
  document.getElementById(`capture-${n}`)
);

const captureResults = [1, 2, 3].map(n =>
  document.getElementById(`capture-result-${n}`)
);

const applyCalibrationButton =
  document.getElementById("apply-calibration");

const loadCalibrationButton =
  document.getElementById("load-calibration");

const clearCalibrationButton =
  document.getElementById("clear-calibration");

const calibrationMessage =
  document.getElementById("calibration-message");

let calibrationPoints = [null, null, null];
let calibrationWindow = [];
let activeCalibration = null;

let recordingCalibration = null;
let recordingIsArduino = false;

// Calibration cannot change during a recording.
function updateCalibrationControls() {
  const locked = serialPort === null || isRecording;

  captureButtons.forEach(button => button.disabled = locked);
  bufferInputs.forEach(input => input.disabled = locked);
  sensorNameInput.disabled = locked;

  applyCalibrationButton.disabled =
    locked || calibrationPoints.some(point => !point);

  loadCalibrationButton.disabled = locked;
  clearCalibrationButton.disabled = locked;
}

// Switch the live display and graph to the selected units.
function setCalibrationMode(profile) {
  activeCalibration = profile;
  isVoltageMode = serialPort !== null && !profile;

  readings = [];
  readingUnit.textContent = isVoltageMode ? "V" : "pH";
  targetInput.disabled = isVoltageMode;

  calibrationStatus.textContent = profile
    ? `Calibrated: ${profile.sensorName}. No temperature compensation.`
    : "Not calibrated — displaying sensor voltage.";

  phDisplay.textContent = "—";
  lastLiveDisplayTime = -Infinity;

  if (isVoltageMode) {
    thresholdDisplay.textContent =
      "pH threshold unavailable until calibration.";
  } else {
    updateThreshold();
  }

  drawGraph();
}

// Fit one straight line through the three calibration points.
function makeCalibration(points, sensorName) {
  if (
    !sensorName ||
    points.length !== 3 ||
    points.some(p =>
      !p ||
      !Number.isFinite(p.ph) ||
      p.ph < 0 ||
      p.ph > 14 ||
      !Number.isFinite(p.voltage) ||
      p.voltage <= 0 ||
      p.voltage >= 5
    )
  ) {
    throw new Error(
      "Enter a sensor name and capture all three buffers."
    );
  }

  const ordered = [...points].sort((a, b) => a.ph - b.ph);
  const d1 = ordered[1].voltage - ordered[0].voltage;
  const d2 = ordered[2].voltage - ordered[1].voltage;

  if (
    ordered[0].ph === ordered[1].ph ||
    ordered[1].ph === ordered[2].ph ||
    Math.abs(d1) < 0.02 ||
    Math.abs(d2) < 0.02 ||
    d1 * d2 <= 0
  ) {
    throw new Error(
      "Use three different buffers with distinct, consistently ordered voltages."
    );
  }

  const meanV =
    points.reduce((sum, p) => sum + p.voltage, 0) / 3;

  const meanPh =
    points.reduce((sum, p) => sum + p.ph, 0) / 3;

  let numerator = 0;
  let denominator = 0;

  for (const point of points) {
    numerator +=
      (point.voltage - meanV) * (point.ph - meanPh);

    denominator += (point.voltage - meanV) ** 2;
  }

  const slope = numerator / denominator;
  const intercept = meanPh - slope * meanV;

  const maxResidual = Math.max(...points.map(p =>
    Math.abs(slope * p.voltage + intercept - p.ph)
  ));

  if (maxResidual > 0.2) {
    throw new Error(
      "The buffer readings do not fit a straight line well. Recheck the values and recapture."
    );
  }

  return {
    sensorName,
    slope,
    intercept,
    maxResidual,
    points: points.map(p => ({ ...p })),
    calibratedAt: new Date().toISOString()
  };
}

// Capture the recent voltage average for a known buffer.
captureButtons.forEach((button, index) => {
  button.addEventListener("click", () => {
    if (serialPort === null || isRecording) return;

    try {
      const ph = bufferInputs[index].valueAsNumber;
      const now = performance.now();

      const samples = calibrationWindow.filter(p =>
        now - p.at <= 5000
      );

      if (!Number.isFinite(ph) || ph < 0 || ph > 14) {
        throw new Error(
          "Enter the buffer's labeled pH between 0 and 14."
        );
      }

      if (
        samples.length < 40 ||
        samples.at(-1).at - samples[0].at < 4500 ||
        now - samples.at(-1).at > 500
      ) {
        throw new Error(
          "Wait for at least five seconds of fresh readings, then capture."
        );
      }

      const voltages = samples.map(p => p.voltage);

      const spread =
        Math.max(...voltages) - Math.min(...voltages);

      if (
        spread > 0.05 ||
        samples.some(p => p.raw === 0 || p.raw === 1023)
      ) {
        throw new Error(
          "The signal is fluctuating or saturated. Let it settle and try again."
        );
      }

      const voltage =
        voltages.reduce((sum, v) => sum + v, 0) /
        samples.length;

      calibrationPoints[index] = {
        ph,
        voltage,
        spread,
        sampleCount: samples.length
      };

      captureResults[index].textContent =
        `Captured ${voltage.toFixed(4)} V at pH ${ph}.`;

      calibrationWindow = [];

      calibrationMessage.textContent =
        "Captured. Rinse, move to the next buffer, and wait for it to stabilize.";

      updateCalibrationControls();
    } catch (error) {
      calibrationMessage.textContent = error.message;
    }
  });
});

// Changing a buffer label requires a new capture.
bufferInputs.forEach((input, index) => {
  input.addEventListener("input", () => {
    calibrationPoints[index] = null;
    captureResults[index].textContent = "Not captured";
    updateCalibrationControls();
  });
});

sensorNameInput.addEventListener("input", () => {
  calibrationPoints = [null, null, null];
  calibrationWindow = [];

  captureResults.forEach(result =>
    result.textContent = "Not captured"
  );

  updateCalibrationControls();
});

applyCalibrationButton.addEventListener("click", () => {
  if (serialPort === null || isRecording) return;

  try {
    const profile = makeCalibration(
      calibrationPoints,
      sensorNameInput.value.trim()
    );

    setCalibrationMode(profile);

    calibrationMessage.textContent =
      `Applied. Largest buffer fit error: ${
        profile.maxResidual.toFixed(3)
      } pH.`;

    try {
      localStorage.setItem(
        `ph-calibration:${profile.sensorName}`,
        JSON.stringify(profile)
      );
    } catch {
      calibrationMessage.textContent +=
        " Could not remember this profile on this browser.";
    }
  } catch (error) {
    calibrationMessage.textContent = error.message;
  }
});

loadCalibrationButton.addEventListener("click", () => {
  if (serialPort === null || isRecording) return;

  try {
    const name = sensorNameInput.value.trim();

    const saved = JSON.parse(
      localStorage.getItem(`ph-calibration:${name}`)
    );

    if (!saved || saved.sensorName !== name) {
      throw new Error(
        "No saved profile for this sensor name on this browser."
      );
    }

    const profile = makeCalibration(saved.points, name);
    profile.calibratedAt = saved.calibratedAt;

    setCalibrationMode(profile);

    calibrationMessage.textContent =
      `Loaded calibration from ${profile.calibratedAt}. ` +
      "Verify it with a buffer before testing.";
  } catch (error) {
    calibrationMessage.textContent = error.message;
  }
});

clearCalibrationButton.addEventListener("click", () => {
  if (serialPort === null || isRecording) return;

  setCalibrationMode(null);

  calibrationMessage.textContent =
    "Using voltage mode. The saved profile is still available.";
});

// ---------- Response time during calibration ----------

let previousBufferCapture = null;
let pendingBufferChange = null;
let latestResponseTest = null;

const responsePanel = document.createElement("div");
responsePanel.style.marginTop = "20px";

const markBufferButton = document.createElement("button");
markBufferButton.type = "button";
markBufferButton.textContent = "Mark Buffer Change";

const responseSummary = document.createElement("p");
responseSummary.setAttribute("aria-live", "polite");
responseSummary.textContent =
  "Capture the first stable buffer. For each next buffer, " +
  "click Mark Buffer Change when the probe enters it.";

responsePanel.append(markBufferButton, responseSummary);
calibrationMessage.insertAdjacentElement("afterend", responsePanel);

// These samples are separate from the five-second capture window.
function recordCalibrationResponseSample(at, voltage, raw) {
  if (!pendingBufferChange || at < pendingBufferChange.at) return;

  // Limit a transition to five minutes.
  if (at - pendingBufferChange.at > 300000) {
    pendingBufferChange = null;
    responseSummary.textContent =
      "Response test timed out. Capture a stable baseline and try again.";
    return;
  }

  pendingBufferChange.samples.push({ at, voltage, raw });
}

markBufferButton.addEventListener("click", () => {
  if (serialPort === null || isRecording) {
    responseSummary.textContent =
      "Connect Arduino and stop recording before measuring response time.";
    return;
  }

  if (!previousBufferCapture) {
    responseSummary.textContent =
      "Capture the first stable buffer before marking a change.";
    return;
  }

  pendingBufferChange = {
    at: performance.now(),
    graphTime: (performance.now() - serialStartTime) / 1000,
    start: { ...previousBufferCapture },
    samples: []
  };

  latestResponseTest = null;

  responseSummary.textContent =
    "Change marked. Leave the probe in the new buffer until stable, " +
    "then click that buffer's Capture button.";
});

// Require the reading to remain beyond the T90 threshold for one second.
// Interpolate the initial crossing between adjacent samples.
function calculateBufferResponse(change, end) {
  const delta = end.voltage - change.start.voltage;

  if (Math.abs(delta) < 0.02) {
    throw new Error(
      "Voltage change is too small for a reliable T90 measurement."
    );
  }

  const samples = change.samples;

  if (
    samples.length < 2 ||
    samples.some(p => p.raw === 0 || p.raw === 1023)
  ) {
    throw new Error(
      "Insufficient response data or a saturated signal."
    );
  }

  const targetVoltage = change.start.voltage + 0.9 * delta;
  const direction = Math.sign(delta);

  let candidate = null;
  let confirmed = false;

  for (let i = 0; i < samples.length; i++) {
    const sample = samples[i];

    // A large sampling gap cannot establish a continuous crossing.
    if (i > 0 && sample.at - samples[i - 1].at > 500) {
      candidate = null;
    }

    const beyond =
      direction * (sample.voltage - targetVoltage) >= 0;

    if (!beyond) {
      candidate = null;
      continue;
    }

    if (candidate === null) {
      const previous = samples[i - 1];

      if (!previous) {
        throw new Error(
          "The first sample already reached 90%. " +
          "Mark the change earlier for a measurable T90."
        );
      }

      if (
        sample.at - previous.at > 500 ||
        direction * (previous.voltage - targetVoltage) >= 0
      ) {
        continue;
      }

      const fraction =
        (targetVoltage - previous.voltage) /
        (sample.voltage - previous.voltage);

      candidate =
        previous.at + fraction * (sample.at - previous.at);
    }

    if (sample.at - candidate >= 1000) {
      confirmed = true;
      break;
    }
  }

  if (!confirmed) {
    throw new Error(
      "No sustained 90% crossing found. Let the next buffer settle longer."
    );
  }

  return {
    fromPh: change.start.ph,
    toPh: end.ph,
    startVoltage: change.start.voltage,
    finalVoltage: end.voltage,
    targetVoltage,
    t90Seconds: (candidate - change.at) / 1000,
    markedAt: new Date().toISOString(),
    graphTime: change.graphTime,
    confirmationSeconds: 1,
    samples: samples.map(p => ({
      seconds: (p.at - change.at) / 1000,
      voltage: p.voltage
    }))
  };
}

// The original capture handler runs first.
// Only process a capture if it successfully created a new point.
captureButtons.forEach((button, index) => {
  let lastProcessedPoint = null;

  button.addEventListener("click", () => {
    const point = calibrationPoints[index];

    if (!point || point === lastProcessedPoint) return;
    lastProcessedPoint = point;

    // Ignore points left over from an unsuccessful capture attempt.
    if (point === previousBufferCapture) return;

    if (!pendingBufferChange) {
      previousBufferCapture = point;

      responseSummary.textContent =
        `Baseline captured at pH ${point.ph}. ` +
        "Move to the next buffer and mark when the probe enters it.";
      return;
    }

    try {
      const result = calculateBufferResponse(
        pendingBufferChange,
        point
      );

      // makeCalibration() already copies all point properties.
      // This therefore travels with the saved calibration profile.
      point.responseTest = result;
      latestResponseTest = result;

      captureResults[index].textContent +=
        ` T90: ${result.t90Seconds.toFixed(2)} s.`;

      responseSummary.textContent =
        `pH ${result.fromPh} → ${result.toPh}: ` +
        `T90 = ${result.t90Seconds.toFixed(2)} seconds. ` +
        "The threshold crossing was confirmed for one second.";
    } catch (error) {
      responseSummary.textContent =
        `Buffer calibration captured; T90 unavailable. ${error.message}`;
    }

    previousBufferCapture = point;
    pendingBufferChange = null;
    drawGraph();
  });
});

function showSavedResponseResults(profile) {
  const tests = profile?.points
    ?.map(p => p.responseTest)
    .filter(Boolean) || [];

  if (!tests.length) {
    responseSummary.textContent =
      "This calibration has no saved response-time measurements.";
    return;
  }

  responseSummary.textContent = tests.map(test =>
    `pH ${test.fromPh} → ${test.toPh}: ` +
    `T90 ${test.t90Seconds.toFixed(2)} s`
  ).join(" | ");
}

applyCalibrationButton.addEventListener("click", () => {
  if (activeCalibration) {
    showSavedResponseResults(activeCalibration);
  }
});

loadCalibrationButton.addEventListener("click", () => {
  if (activeCalibration) {
    showSavedResponseResults(activeCalibration);
  }
});

function resetCalibrationResponse() {
  previousBufferCapture = null;
  pendingBufferChange = null;
  latestResponseTest = null;

  responseSummary.textContent =
    "Capture a stable baseline buffer before marking the next change.";
}

sensorNameInput.addEventListener("input", resetCalibrationResponse);
bufferInputs.forEach(input =>
  input.addEventListener("input", resetCalibrationResponse)
);

clearCalibrationButton.addEventListener("click", () => {
  if (serialPort !== null && !isRecording) {
    resetCalibrationResponse();
  }
});

connectButton.addEventListener("click", resetCalibrationResponse);
resetButton.addEventListener("click", resetCalibrationResponse);

// Add response markers using the existing graph's coordinates.
const drawGraphWithoutResponseMarkers = drawGraph;

drawGraph = function () {
  drawGraphWithoutResponseMarkers();

  const test = latestResponseTest;
  const change = pendingBufferChange;
  const markerTime = test?.graphTime ?? change?.graphTime;

  if (!Number.isFinite(markerTime) || readings.length === 0) return;

  const latestTime = readings.at(-1).time;
  if (markerTime > latestTime) return;

  const left = 50;
  const right = canvas.width - 20;
  const top = 20;
  const bottom = canvas.height - 40;
  const maxTime = Math.max(10, latestTime);

  const xFor = time =>
    left + (right - left) * time / maxTime;

  ctx.save();
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 5]);
  ctx.strokeStyle = "#ffffff";

  const changeX = xFor(markerTime);
  ctx.beginPath();
  ctx.moveTo(changeX, top);
  ctx.lineTo(changeX, bottom);
  ctx.stroke();

  if (test) {
    const value = isVoltageMode
      ? test.targetVoltage
      : activeCalibration
        ? activeCalibration.slope * test.targetVoltage +
          activeCalibration.intercept
        : null;

    const maximum = isVoltageMode ? 5 : 14;

    if (Number.isFinite(value) && value >= 0 && value <= maximum) {
      const y = top + (bottom - top) * (1 - value / maximum);

      ctx.strokeStyle = "#ff8ac6";
      ctx.beginPath();
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
      ctx.stroke();
    }

    const t90Time = markerTime + test.t90Seconds;

    if (t90Time <= latestTime) {
      ctx.strokeStyle = "#ff8ac6";
      ctx.beginPath();
      ctx.moveTo(xFor(t90Time), top);
      ctx.lineTo(xFor(t90Time), bottom);
      ctx.stroke();
    }
  }

  ctx.restore();
};