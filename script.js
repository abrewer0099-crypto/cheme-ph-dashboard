const phDisplay = document.getElementById("ph-value");
const elapsedDisplay = document.getElementById("elapsed-time");
const statusDisplay = document.getElementById("status");
const demoButton = document.getElementById("demo-button");
const targetInput = document.getElementById("target-ph");
const thresholdDisplay = document.getElementById("threshold-status");

const recordButton = document.getElementById("record-button");
const exportButton = document.getElementById("export-button");
const resetButton = document.getElementById("reset-button");
const recordingTimeDisplay = document.getElementById("recording-time");

const intervalInput = document.getElementById("recording-interval");

const minimumPhDisplay = document.getElementById("minimum-ph");
const maximumPhDisplay = document.getElementById("maximum-ph");
const averagePhDisplay = document.getElementById("average-ph");

const canvas = document.getElementById("ph-chart");
const ctx = canvas.getContext("2d");

const saveTestButton = document.getElementById("save-test-button");
const saveStatus = document.getElementById("save-status");
const savedTestsDisplay = document.getElementById("saved-tests");

const SUPABASE_URL = "https://kfwdbwujptkkrnfevktm.supabase.co";
const SUPABASE_KEY = "sb_publishable_S3aguOf81Lk4XBbYoV19Qg_O74MgzCf";

const connectButton = document.getElementById("connect-button");
const readingUnit = document.getElementById("reading-unit");
const calibrationStatus = document.getElementById("calibration-status");

const LIVE_DISPLAY_INTERVAL_MS = 250;

let isSaving = false;
let currentRecordingId = null;

let recordingTimer = null;
let isRecording = false;
let recordedReadings = [];
let recordingStartTime = 0;

let demoTimer = null;
let startTime = 0;
let readings = [];

let recordingIntervalMs = 100;
let nextRecordingSampleTime = 0;

let serialPort = null;
let serialReader = null;
let serialStartTime = 0;

let isVoltageMode = false;

let recordingIsVoltage = false;

let lastLiveDisplayTime = -Infinity;

// Calculate statistics using only the current recording.
function updateTestStatistics() {
  if (!minimumPhDisplay || !maximumPhDisplay || !averagePhDisplay) {
    return;
  }

  if (recordedReadings.length === 0 || recordingIsVoltage) {
    minimumPhDisplay.textContent = "—";
    maximumPhDisplay.textContent = "—";
    averagePhDisplay.textContent = "—";
    return;
  }

  let minimum = Infinity;
  let maximum = -Infinity;
  let total = 0;

  for (const reading of recordedReadings) {
    minimum = Math.min(minimum, reading.ph);
    maximum = Math.max(maximum, reading.ph);
    total += reading.ph;
  }

  const average = total / recordedReadings.length;

  minimumPhDisplay.textContent = minimum.toFixed(2);
  maximumPhDisplay.textContent = maximum.toFixed(2);
  averagePhDisplay.textContent = average.toFixed(2);
}

function drawGraph() {
  const width = canvas.width;
  const height = canvas.height;
  const maximumValue = isVoltageMode ? 5 : 14;
  const gridStep = isVoltageMode ? 1 : 2;

  document.getElementById("chart-title").textContent = 
    isVoltageMode ? "Voltage over time" : "pH over time";
   
  canvas.setAttribute(
    "aria-label",
    isVoltageMode
      ? "Sensor voltage versus elapsed time"
      : "pH versus elapsed time"
  ); 

  const margin = { left: 50, right: 20, top: 20, bottom: 40 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;

  ctx.clearRect(0, 0, width, height);
  ctx.font = "14px Arial";
  ctx.lineWidth = 1;
  ctx.setLineDash([]);

  // Draw pH grid lines and labels.
  for (let ph = 0; ph <= maximumValue; ph += gridStep) {
    const y =
      margin.top + plotHeight * (1 - ph / maximumValue);

    ctx.strokeStyle = "#304252";
    ctx.beginPath();
    ctx.moveTo(margin.left, y);
    ctx.lineTo(width - margin.right, y);
    ctx.stroke();

    ctx.fillStyle = "#aab9c8";
    ctx.textAlign = "right";
    ctx.fillText(ph, margin.left - 10, y + 5);
  }

  const maxTime = Math.max(10, readings.at(-1)?.time ?? 0);

  // Draw time labels.
  ctx.textAlign = "center";

  for (let i = 0; i <= 5; i++) {
    const x = margin.left + plotWidth * i / 5;
    const time = maxTime * i / 5;

    ctx.fillStyle = "#aab9c8";
    ctx.fillText(time.toFixed(1), x, height - 20);
  }

  ctx.fillText("Time (s)", width / 2, height - 3);

  // Draw the target threshold as a dashed line.
  const target = targetInput.valueAsNumber;

 if (
  !isVoltageMode &&
  Number.isFinite(target) &&
  target >= 0 &&
  target <= 14
) {
  const targetY =
    margin.top + plotHeight * (1 - target / 14);

  ctx.strokeStyle = "#ffcc66";
  ctx.setLineDash([6, 6]);
  ctx.beginPath();
  ctx.moveTo(margin.left, targetY);
  ctx.lineTo(width - margin.right, targetY);
  ctx.stroke();
  ctx.setLineDash([]);
}

  // Draw live readings.
  ctx.strokeStyle = "#58d6bd";
  ctx.lineWidth = 2;
  ctx.beginPath();

  readings.forEach((reading, index) => {
    const x = margin.left + plotWidth * reading.time / maxTime;
    const value = isVoltageMode ? reading.voltage : reading.ph;

    const y =
       margin.top + plotHeight * (1 - value / maximumValue);

    if (index === 0) {
      ctx.moveTo(x, y);
    } else {
      ctx.lineTo(x, y);
    }
  });

  ctx.stroke();
  ctx.lineWidth = 1;
}

function updateThreshold() {
  const latest = readings.at(-1);
  const target = targetInput.valueAsNumber;

  if (!Number.isFinite(target) || target < 0 || target > 14) {
    thresholdDisplay.textContent = "Enter a target between 0 and 14.";
    return;
  }

  if (!latest) {
    thresholdDisplay.textContent = "Waiting for readings";
    return;
  }

  thresholdDisplay.textContent = latest.ph <= target
    ? "Target reached — pH is at or below the threshold"
    : "pH is above the target";
}

function takeDemoReading() {
  const now = performance.now();
  const time = (now - startTime) / 1000;

  // Simulates pH dropping from 10 toward 3, with slight noise.
  const noise = (Math.random() - 0.5) * 0.08;
  const ph = Math.max(3, 10 - time * 0.1 + noise);

  readings.push({ time, ph });

  if (
    isRecording &&
    !recordingIsArduino &&
    now >= nextRecordingSampleTime
  ) {
    recordedReadings.push({
      time: (now - recordingStartTime) / 1000,
      ph,
      recording_interval_ms: recordingIntervalMs
    });

    //advance to the next scheduled recording time
    const intervalsPassed = Math.floor(
      (now - nextRecordingSampleTime) / recordingIntervalMs
    );

    nextRecordingSampleTime +=
      (intervalsPassed + 1) * recordingIntervalMs;

    updateTestStatistics();  
  }

  phDisplay.textContent = ph.toFixed(2);
  elapsedDisplay.textContent = time.toFixed(1);

  updateThreshold();
  drawGraph();
}

function stopRecording() {
  if (isRecording) {
    const seconds = (performance.now() - recordingStartTime) / 1000;
    recordingTimeDisplay.textContent = seconds.toFixed(1);
  }

  clearInterval(recordingTimer);
  recordingTimer = null;

  isRecording = false;
  updateCalibrationControls();
  intervalInput.disabled = false;
  recordButton.textContent = "Start Recording";
  exportButton.disabled = recordedReadings.length === 0;
  saveTestButton.disabled = 
    recordedReadings.length === 0 || recordingIsVoltage;

  updateTestStatistics();
}

demoButton.addEventListener("click", () => {
  if (serialPort !== null) {
    return;
  }
  if (demoTimer !== null) {
    clearInterval(demoTimer);
    demoTimer = null;

    stopRecording();
    recordButton.disabled = true;

    demoButton.textContent = "Start Demo";
    statusDisplay.textContent = "Demo stopped";
    return;
  }

  readings = [];
  startTime = performance.now();

  recordButton.disabled = false;
  demoButton.textContent = "Stop Demo";
  statusDisplay.textContent = "Demo running — simulated readings";

  takeDemoReading();
  demoTimer = setInterval(takeDemoReading, 100);
});

recordButton.addEventListener("click", () => {
  if (isRecording) {
    stopRecording();
    return;
  }

  if (demoTimer === null && serialPort === null) {
    return;
  }

  const selectedInterval = intervalInput.valueAsNumber;

  if (
    !Number.isSafeInteger(selectedInterval) ||
    selectedInterval < 100
  ) {
    saveStatus.textContent = 
      "Enter a whole recording interval of at least 100ms.";
    return;  
  }

  recordingIntervalMs = selectedInterval;

  // Each new recording replaces the previous recording.
  recordedReadings = [];
  recordingIsArduino = serialPort !== null;

recordingCalibration = recordingIsArduino && activeCalibration
  ? JSON.parse(JSON.stringify(activeCalibration))
  : null;

recordingIsVoltage =
  recordingIsArduino && !recordingCalibration;
  currentRecordingId = null;

  saveStatus.textContent =
    "Recording started. Stop recording before saving.";

  updateTestStatistics();

  recordingStartTime = performance.now();
  nextRecordingSampleTime = recordingStartTime;
  isRecording = true;
  updateCalibrationControls();

  intervalInput.disabled = true;

  recordingTimeDisplay.textContent = "0.0";
  recordButton.textContent = "Stop Recording";
  exportButton.disabled = true;
  saveTestButton.disabled = true;

  recordingTimer = setInterval(() => {
    const seconds = (performance.now() - recordingStartTime) / 1000;
    recordingTimeDisplay.textContent = seconds.toFixed(1);
  }, 100);
});

exportButton.addEventListener("click", () => {
  if (isRecording || recordedReadings.length === 0) {
    return;
  }

  if (typeof XLSX === "undefined") {
    alert(
      "Excel library did not load. Check your internet connection and refresh."
    );
    return;
  }

const rows = [
  [
    "Time (seconds)",
    "pH",
    "Voltage (V)",
    "Raw ADC",
    "Recording interval (ms)",
    "Source"
  ],

  ...recordedReadings.map(reading => [
    Number(reading.time.toFixed(3)),

    Number.isFinite(reading.ph)
      ? Number(reading.ph.toFixed(3))
      : null,

    reading.voltage ?? null,
    reading.raw ?? null,
    reading.recording_interval_ms,

    recordingIsArduino
      ? recordingIsVoltage
        ? "Arduino — uncalibrated"
        : "Arduino"
      : "Demo"
  ])
];

  const worksheet = XLSX.utils.aoa_to_sheet(rows);

worksheet["!cols"] =
  [20, 12, 15, 12, 24, 28].map(wch => ({ wch }));

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Measurements");

  const timestamp = new Date()
    .toISOString()
    .replace(/[:.]/g, "-");

  XLSX.writeFile(workbook, `ph-test-${timestamp}.xlsx`);
});

resetButton.addEventListener("click", () => {
  clearInterval(demoTimer);
  demoTimer = null;

  stopRecording();

  // Clear current measurements, preserving saved tests.
  readings = [];
  recordedReadings = [];
  startTime = 0;
  recordingStartTime = 0;
  currentRecordingId = null;

  phDisplay.textContent = "—";
  elapsedDisplay.textContent = "0.0";
  recordingTimeDisplay.textContent = "0.0";

  statusDisplay.textContent = "Reset — ready for demo mode";
  demoButton.textContent = "Start Demo";
  recordButton.textContent = "Start Recording";

  recordButton.disabled = true;
  exportButton.disabled = true;
  saveTestButton.disabled = true;

  updateTestStatistics();
  updateThreshold();
  drawGraph();
});

targetInput.addEventListener("input", () => {
  updateThreshold();
  drawGraph();
});

function getTestDetails() {
  const solutionName = document
    .getElementById("solution-name")
    .value.trim();

  const concentration = document
    .getElementById("concentration")
    .valueAsNumber;

  const concentrationUnit = document
    .getElementById("concentration-unit")
    .value.trim();

  const titrantVolume = document
    .getElementById("titrant-volume")
    .valueAsNumber;

  if (!solutionName) {
    throw new Error("Enter a solution name.");
  }

  if (!Number.isFinite(concentration) || concentration < 0) {
    throw new Error("Enter a concentration of zero or greater.");
  }

  if (!concentrationUnit) {
    throw new Error("Enter a concentration unit, such as mol/L.");
  }

  if (!Number.isFinite(titrantVolume) || titrantVolume < 0) {
    throw new Error(
      "Enter the total titrant added in mL. Enter 0 if none was added."
    );
  }

  return {
    solutionName,
    concentration,
    concentrationUnit,
    titrantVolume
  };
}

  function showTestEditor(test, item, editButton) {
  const form = document.createElement("form");
  form.className = "test-fields";
  form.style.marginTop = "20px";

  function addField(labelText, value, type = "text") {
    const container = document.createElement("div");
    const label = document.createElement("label");
    const input = document.createElement("input");

    input.type = type;
    input.value = String(value);
    input.required = true;

    if (type === "number") {
      input.min = "0";
      input.step = "any";
    }

    label.append(document.createTextNode(labelText), input);
    container.append(label);
    form.append(container);

    return input;
  }

  const nameInput = addField("Solution name", test.solution_name);
  nameInput.maxLength = 200;

  const concentrationInput = addField(
    "Concentration",
    test.concentration,
    "number"
  );

  const unitInput = addField(
    "Concentration unit",
    test.concentration_unit
  );
  unitInput.maxLength = 50;

  const volumeInput = addField(
    "Total titrant added (mL)",
    test.titrant_volume_ml,
    "number"
  );

  const controls = document.createElement("div");
  controls.className = "buttons";

  const saveButton = document.createElement("button");
  saveButton.type = "submit";
  saveButton.textContent = "Save Changes";

  const cancelButton = document.createElement("button");
  cancelButton.type = "button";
  cancelButton.textContent = "Cancel";

  const message = document.createElement("p");
  message.setAttribute("aria-live", "polite");

  controls.append(saveButton, cancelButton);
  form.append(controls, message);
  item.append(form);

  nameInput.focus();

  cancelButton.addEventListener("click", () => {
    form.remove();
    editButton.disabled = false;
  });

  form.addEventListener("submit", async event => {
    event.preventDefault();

    const solutionName = nameInput.value.trim();
    const concentrationUnit = unitInput.value.trim();
    const concentration = concentrationInput.valueAsNumber;
    const titrantVolume = volumeInput.valueAsNumber;

    if (!solutionName || !concentrationUnit) {
      message.textContent = "Enter a solution name and concentration unit.";
      return;
    }

    if (
      !Number.isFinite(concentration) ||
      concentration < 0 ||
      !Number.isFinite(titrantVolume) ||
      titrantVolume < 0
    ) {
      message.textContent =
        "Concentration and titrant volume must be zero or greater.";
      return;
    }

    const inputs = [
      nameInput,
      concentrationInput,
      unitInput,
      volumeInput
    ];

    saveButton.disabled = true;
    cancelButton.disabled = true;
    inputs.forEach(input => {
      input.disabled = true;
    });

    message.textContent = "Saving changes…";

    try {
      const response = await fetch(
        `${SUPABASE_URL}/rest/v1/ph_tests` +
        `?id=eq.${encodeURIComponent(test.id)}&select=id`,
        {
          method: "PATCH",
          headers: {
            apikey: SUPABASE_KEY,
            "Content-Type": "application/json",
            Prefer: "return=representation"
          },
          body: JSON.stringify({
            solution_name: solutionName,
            concentration,
            concentration_unit: concentrationUnit,
            titrant_volume_ml: titrantVolume
          })
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.message || "Could not update the test.");
      }

      const updatedTests = await response.json();

      if (updatedTests.length !== 1) {
        throw new Error(
          "The test was not updated. Check its editing permissions."
        );
      }

      saveStatus.textContent = `Updated: ${solutionName}.`;
      await loadSavedTests();
    } catch (error) {
      message.textContent =
        `Update could not be confirmed: ${error.message}`;
    } finally {
      saveButton.disabled = false;
      cancelButton.disabled = false;

      inputs.forEach(input => {
        input.disabled = false;
      });
    }
  });
}

async function loadSavedTests() {
  savedTestsDisplay.textContent = "Loading saved tests…";

  const columns = [
    "id",
    "created_at",
    "solution_name",
    "concentration",
    "concentration_unit",
    "titrant_volume_ml",
    "source",
    "minimum_ph",
    "maximum_ph",
    "average_ph"
  ].join(",");

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/ph_tests` +
      `?select=${columns}&order=created_at.desc&limit=50`,
      {
        headers: {
          apikey: SUPABASE_KEY
        }
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || "Could not load saved tests.");
    }

    const tests = await response.json();
    savedTestsDisplay.replaceChildren();

    if (tests.length === 0) {
      savedTestsDisplay.textContent = "No saved tests yet.";
      return;
    }

    for (const test of tests) {
      const item = document.createElement("article");

      const title = document.createElement("h3");
      title.textContent = test.solution_name;

      const details = document.createElement("p");
      details.textContent =
        `${test.concentration} ${test.concentration_unit}` +
        ` • Titrant: ${test.titrant_volume_ml} mL` +
        ` • Source: ${test.source}`;

      const statistics = document.createElement("p");
      statistics.textContent =
        `Lowest: ${test.minimum_ph.toFixed(2)}` +
        ` • Highest: ${test.maximum_ph.toFixed(2)}` +
        ` • Average: ${test.average_ph.toFixed(2)}`;

      const date = document.createElement("p");
      date.textContent = new Date(test.created_at).toLocaleString();

      const editButton = document.createElement("button");
      editButton.type = "button";
      editButton.textContent = "Edit Test";

      editButton.addEventListener("click", () => {
        editButton.disabled = true;
        showTestEditor(test,item,editButton);
      });
      const deleteButton = document.createElement("button");
deleteButton.type = "button";
deleteButton.textContent = "Delete Test";

const cancelDeleteButton = document.createElement("button");
cancelDeleteButton.type = "button";
cancelDeleteButton.textContent = "Cancel";
cancelDeleteButton.hidden = true;

const deleteStatus = document.createElement("p");

let awaitingDeleteConfirmation = false;

cancelDeleteButton.addEventListener("click", () => {
  awaitingDeleteConfirmation = false;
  deleteButton.textContent = "Delete Test";
  cancelDeleteButton.hidden = true;
  deleteStatus.textContent = "";
});

deleteButton.addEventListener("click", async () => {
  // The first click only asks for confirmation.
  if (!awaitingDeleteConfirmation) {
    awaitingDeleteConfirmation = true;
    deleteButton.textContent = "Confirm Delete";
    cancelDeleteButton.hidden = false;
    deleteStatus.textContent =
      `Permanently delete "${test.solution_name}" and its readings?`;
    return;
  }

  // The second click sends the deletion request.
  deleteButton.disabled = true;
  cancelDeleteButton.disabled = true;
  deleteStatus.textContent = "Deleting…";

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/ph_tests` +
      `?id=eq.${encodeURIComponent(test.id)}&select=id`,
      {
        method: "DELETE",
        headers: {
          apikey: SUPABASE_KEY,
          Prefer: "return=representation"
        }
      }
    );

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.message || "Could not delete this test.");
    }

    if (!Array.isArray(result) || result.length !== 1) {
      throw new Error(
        "Nothing was deleted. The test may already be gone, or deletion is not allowed."
      );
    }

    saveStatus.textContent = `Deleted "${test.solution_name}".`;
    await loadSavedTests();
  } catch (error) {
    deleteStatus.textContent = error.message;
    deleteButton.disabled = false;
    cancelDeleteButton.disabled = false;
  }
});

const testActions = document.createElement("div");
testActions.className = "test-actions";

  testActions.append(
    editButton,
    deleteButton,
    cancelDeleteButton
  );
  item.append(
    title,
    details,
    statistics,
    date,
    testActions,
    deleteStatus
  );
      savedTestsDisplay.append(item);
    }
  } catch (error) {
    savedTestsDisplay.textContent =
      `Could not load saved tests: ${error.message}`;
  }
}

saveTestButton.addEventListener("click", async () => {
  if (isSaving) return;

  if (recordingIsVoltage) {
    saveStatus.textContent =
      "Export this voltage recording to Excel. Shared pH saving requires calibration.";
    return;  
  }

  if (isRecording || recordedReadings.length === 0) {
    saveStatus.textContent =
      "Stop a recording containing readings before saving.";
    return;
  }

  let test;

  try {
    const details = getTestDetails();

    // Copy the readings so the test stays unchanged during saving.
    const measurements = recordedReadings.map(reading => ({
      time: reading.time,
      ph: reading.ph,
      voltage: reading.voltage,
      raw: reading.raw,
      calibration: reading.calibration,
      recording_interval_ms: reading.recording_interval_ms
    }));

    let minimum = Infinity;
    let maximum = -Infinity;
    let total = 0;

    for (const reading of measurements) {
      minimum = Math.min(minimum, reading.ph);
      maximum = Math.max(maximum, reading.ph);
      total += reading.ph;
    }

    // Reuse the ID if saving is retried to prevent duplicates.
    currentRecordingId ??= crypto.randomUUID();

    test = {
      id: currentRecordingId,
      solution_name: details.solutionName,
      concentration: details.concentration,
      concentration_unit: details.concentrationUnit,
      titrant_volume_ml: details.titrantVolume,
      source: recordingIsArduino ? "Arduino" : "Demo",
      minimum_ph: minimum,
      maximum_ph: maximum,
      average_ph: total / measurements.length,
      readings: measurements
    };
  } catch (error) {
    saveStatus.textContent = error.message;
    return;
  }

  isSaving = true;
  saveTestButton.disabled = true;
  saveStatus.textContent = "Saving test…";

  let saved = false;

  try {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/ph_tests?on_conflict=id`,
      {
        method: "POST",
        headers: {
          apikey: SUPABASE_KEY,
          "Content-Type": "application/json",
          Prefer: "resolution=ignore-duplicates,return=minimal"
        },
        body: JSON.stringify(test)
      }
    );

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || "Could not save the test.");
    }

    saved = true;
    saveStatus.textContent = `Saved: ${test.solution_name}.`;

    await loadSavedTests();
  } catch (error) {
    saveStatus.textContent =
      `Save could not be confirmed: ${error.message}. You can retry.`;
  } finally {
    isSaving = false;

    saveTestButton.disabled =
      isRecording ||
      recordedReadings.length === 0 ||
      (saved && currentRecordingId === test.id);
  }
});

function displayArduinoLine(line) {
  let reading;

  try {
    reading = JSON.parse(line);
  } catch {
    return;
  }

  if (
    !Number.isInteger(reading.raw) ||
    reading.raw < 0 ||
    reading.raw > 1023 ||
    !Number.isFinite(reading.voltage) ||
    reading.voltage < 0 ||
    reading.voltage > 5
  ) {
    return;
  }

  const now = performance.now();
  const time = (now - serialStartTime) / 1000;

  recordCalibrationResponseSample(now, reading.voltage, reading.raw);

  // Keep five seconds of samples available for calibration.
  calibrationWindow.push({
    at: now,
    voltage: reading.voltage,
    raw: reading.raw
  });

  calibrationWindow = calibrationWindow.filter(p =>
    now - p.at <= 5000
  );

  // Convert voltage only when a calibration is active.
  const ph = activeCalibration
    ? activeCalibration.slope * reading.voltage +
      activeCalibration.intercept
    : null;

  if (now - lastLiveDisplayTime >= LIVE_DISPLAY_INTERVAL_MS) {
    phDisplay.textContent = ph === null
      ? reading.voltage.toFixed(3)
      : ph.toFixed(2);

    elapsedDisplay.textContent = time.toFixed(1);
    lastLiveDisplayTime = now;
  }

  if (
    isRecording &&
    recordingIsArduino &&
    now >= nextRecordingSampleTime
  ) {
    const recordedPh = recordingCalibration
      ? recordingCalibration.slope * reading.voltage +
        recordingCalibration.intercept
      : null;

    recordedReadings.push({
      time: (now - recordingStartTime) / 1000,
      ph: recordedPh,
      voltage: reading.voltage,
      raw: reading.raw,
      calibration: recordingCalibration,
      recording_interval_ms: recordingIntervalMs
    });

    const intervalsPassed = Math.floor(
      (now - nextRecordingSampleTime) / recordingIntervalMs
    );

    nextRecordingSampleTime +=
      (intervalsPassed + 1) * recordingIntervalMs;

    updateTestStatistics();
  }

  readings.push({
    time,
    ph,
    voltage: reading.voltage,
    raw: reading.raw
  });

  if (readings.length > 6000) readings.shift();

  if (activeCalibration) updateThreshold();

  drawGraph();

  const extrapolated = activeCalibration && (
    ph < Math.min(...activeCalibration.points.map(p => p.ph)) ||
    ph > Math.max(...activeCalibration.points.map(p => p.ph))
  );

  statusDisplay.textContent = ph === null
    ? "Arduino connected — receiving sensor voltage"
    : extrapolated
      ? "Arduino connected — pH estimate outside calibrated buffer range"
      : "Arduino connected — receiving calibrated pH";
}

connectButton.addEventListener("click", async () => {
  //if already connected, cancel the reader
  //the cleanup below will close the port
  if (serialPort !== null) {
    connectButton.disabled = true;
    if (serialPort !== null) {
      stopRecording();
    }

    try {
      await serialReader.cancel();
    } catch (error) {
      statusDisplay.textContent = error.message;
    }

    return;
  }

  connectButton.disabled = true;

  let connectionMessage = "Arduino disconnected";

  try {
    //ask the user to choose a USB serial device
    const selectedPort = await navigator.serial.requestPort();

    //math the baud rate in the arduino sketch
    await selectedPort.open({ baudRate: 115200});

    serialPort = selectedPort;

    //stop the demo before displaying real sensor data
        clearInterval(demoTimer);
    demoTimer = null;
    stopRecording();

    activeCalibration = null;
    calibrationWindow = [];
    calibrationPoints = [null, null, null];

    captureResults.forEach(result =>
    result.textContent = "Not captured"
    );

updateCalibrationControls();
    isVoltageMode = true;
    readings = [];
    drawGraph();

    demoButton.textContent = "Start Demo";
    demoButton.disabled = true;
    resetButton.disabled = true;
    recordButton.disabled = false;
    targetInput.disabled = true;

    readingUnit.textContent = "V";

    calibrationStatus.textContent =
      "Not calibrated — displaying sensor voltage.";

    thresholdDisplay.textContent =
      "pH threshold unavailable until calibration.";

    phDisplay.textContent = "—";
    elapsedDisplay.textContent = "0.0";

    statusDisplay.textContent =
      "Arduino connected — waiting for readings";

    serialStartTime = performance.now();

    serialReader = serialPort.readable.getReader();

    connectButton.textContent = "Disconnect Arduino";
    connectButton.disabled = false;

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { value, done } = await serialReader.read();

      if (done) break;

      // Convert incoming bytes to text.
      buffer += decoder.decode(value, { stream: true });

      let newlinePosition;

      // Process only complete lines.
      while ((newlinePosition = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlinePosition).trim();

        buffer = buffer.slice(newlinePosition + 1);

        if (line) {
          displayArduinoLine(line);
        }
      }

      // Prevent malformed input from growing forever.
      if (buffer.length > 4096) {
        buffer = "";
      }
    }
  } catch (error) {
    connectionMessage = error.name === "NotFoundError"
      ? "Connection canceled"
      : `Arduino connection error: ${error.message}`;
  } finally {
    if (serialPort !== null){
      stopRecording();
    }
    // Release the reader before closing the port.
    connectButton.disabled = true;

    if (serialReader !== null) {
      serialReader.releaseLock();
      serialReader = null;
    }

    if (serialPort !== null) {
      try {
        await serialPort.close();
      } catch (error) {
        connectionMessage = `Port closed with an error: ${error.message}`;
      }

      serialPort = null;
      activeCalibration = null;
      calibrationWindow = [];
      updateCalibrationControls();
      isVoltageMode = false;
      readings = [];
      drawGraph();

      demoButton.disabled = false;
      resetButton.disabled = false;
      targetInput.disabled = false;
      recordButton.disabled = true;

      readingUnit.textContent = "pH";
      calibrationStatus.textContent = "Demo — simulated pH.";

      phDisplay.textContent = "—";
      elapsedDisplay.textContent = "0.0";

      updateThreshold();
    }

    connectButton.textContent = "Connect Arduino";
    connectButton.disabled = false;

    statusDisplay.textContent = connectionMessage;
  }
})

// Set the initial state.
recordButton.disabled = true;
exportButton.disabled = true;
saveTestButton.disabled = true;

updateTestStatistics();
updateThreshold();
drawGraph();

saveStatus.textContent =
  "Stop a recording and fill in the test details to save.";

loadSavedTests();

connectButton.disabled =
  !("serial" in navigator) || !window.isSecureContext;

updateCalibrationControls();