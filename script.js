/**
 * A self-contained application module for the Multi-Device Audio Router.
 * This object encapsulates all state, DOM elements, and logic.
 */
const app = {
  // --- STATE ---
  audioContext: null,
  sourceNode: null,
  mediaStream: null,
  availableDevices: [],
  activeRoutes: [],
  routeIdCounter: 0,
  config: {
    echoGuard: true, // Echo prevention guard for the default sink
  },

  // --- DOM ELEMENTS ---
  elements: {
    info: document.getElementById("info"),
    warn: document.getElementById("warn"),
    routes: document.getElementById("routes"),
    startBtn: document.getElementById("startCapture"),
    stopBtn: document.getElementById("stopCapture"),
    addBtn: document.getElementById("addRoute"),
    playAllBtn: document.getElementById("playAll"),
    stopAllBtn: document.getElementById("stopAll"),
    refreshBtn: document.getElementById("refreshDevices"),
    onboarding: document.getElementById("onboarding-container"),
  },

  /**
   * Initializes the application by setting up the initial UI state
   * and binding all global event listeners.
   */
  init() {
    this.elements.startBtn.onclick = () => this.startCapture();
    this.elements.stopBtn.onclick = () => this.stopCapture();
    this.elements.addBtn.onclick = () => this.createRoute();
    this.elements.refreshBtn.onclick = () => this.refreshDevices();
    this.elements.playAllBtn.onclick = () =>
      this.activeRoutes.forEach((r) => r.audioEl.play().catch(console.error));
    this.elements.stopAllBtn.onclick = () =>
      this.activeRoutes.forEach((r) => r.audioEl.pause());
    navigator.mediaDevices.addEventListener("devicechange", () =>
      this.refreshDevices()
    );

    this.updateUiState();
    this.refreshDevices();
  },

  /**
   * Updates the enabled/disabled state of global buttons and the
   * visibility of instructional messages based on the current app state.
   */
  updateUiState() {
    const isCapturing = !!this.audioContext;
    this.elements.startBtn.disabled = isCapturing;
    this.elements.stopBtn.disabled = !isCapturing;
    this.elements.addBtn.disabled = !isCapturing;
    this.elements.playAllBtn.disabled =
      !isCapturing || this.activeRoutes.length === 0;
    this.elements.stopAllBtn.disabled =
      !isCapturing || this.activeRoutes.length === 0;

    // Update onboarding/empty state messages
    this.elements.onboarding.style.display = "block";
    if (!isCapturing) {
      this.elements.onboarding.innerHTML = `
        <h3 style="margin-top: 0;">How to Start</h3>
        <ol style="text-align: left; display: inline-block;">
          <li>Click <strong>Start Capture</strong> to begin.</li>
          <li>Choose the browser tab or window with the audio you wish to share.</li>
          <li>Click <strong>+ Add Route</strong> for each speaker or headphone.</li>
        </ol>`;
    } else if (this.activeRoutes.length === 0) {
      this.elements.onboarding.innerHTML = `<p>Capture active! Click <strong>+ Add Route</strong> to get started.</p>`;
    } else {
      this.elements.onboarding.style.display = "none";
    }
  },

  /**
   * Starts screen capture and initializes the AudioContext and source node.
   */
  async startCapture() {
    if (this.mediaStream) return;
    this.elements.warn.textContent = "";

    try {
      this.mediaStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      // Add a listener to stop capture if the user closes the source tab
      this.mediaStream.getTracks().forEach((track) => {
        track.onended = () => this.stopCapture("Source stream ended.");
      });
    } catch (e) {
      this.elements.warn.textContent = "Screen capture failed or was cancelled.";
      return;
    }

    this.mediaStream.getVideoTracks().forEach((track) => track.stop());

    this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
      latencyHint: "interactive",
      sampleRate: 48000,
    });

    await this.audioContext.resume();
    await this.ensureWorkletLoaded();

    this.sourceNode = this.audioContext.createMediaStreamSource(
      this.mediaStream
    );
    this.elements.info.textContent = `Capturing @ ${
      this.audioContext.sampleRate
    } Hz. Latency: ${Math.round(
      this.audioContext.outputLatency * 1000
    )} ms`;

    // Request mic access to get detailed device labels
    try {
      const micStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
      });
      micStream.getTracks().forEach((track) => track.stop());
      await this.refreshDevices();
    } catch (e) {
      /* User may deny mic access, which is fine */
    }

    this.updateUiState();
  },

  /**
   * Stops audio capture and cleans up all audio nodes, routes, and state.
   */
  stopCapture(reason = "Capture stopped.") {
    if (!this.audioContext) return;

    this.mediaStream?.getTracks().forEach((track) => track.stop());
    this.mediaStream = null;

    this.elements.routes.innerHTML = "";
    this.activeRoutes.forEach((route) => {
      route.audioEl.pause();
      Object.values(route.nodes).forEach((node) => node.disconnect());
    });
    this.activeRoutes.length = 0;

    this.sourceNode?.disconnect();
    this.sourceNode = null;

    this.audioContext?.close().catch(console.error);
    this.audioContext = null;

    this.elements.info.textContent = reason;
    this.elements.warn.textContent = "";
    this.updateUiState();
  },

  /**
   * Creates a new audio route, including the audio graph and UI card.
   */
  async createRoute() {
    if (!this.audioContext || !this.sourceNode) {
      this.elements.warn.textContent =
        "You must start capture before adding a route.";
      return;
    }

    const id = this.routeIdCounter++;
    const audioNodes = this.createAudioGraphForRoute();
    const uiElements = this.buildRouteCard(id);

    // BUG FIX: Create audio element and THEN set srcObject.
    const audioEl = new Audio();
    audioEl.srcObject = audioNodes.destinationNode.stream;

    this.bindRouteCardEvents(id, audioNodes, uiElements, audioEl);

    // Populate device dropdown
    this.availableDevices.forEach((device) => {
      uiElements.deviceSelect.add(
        new Option(
          device.label || `Device ${device.deviceId}`,
          device.deviceId
        )
      );
    });

    this.elements.routes.appendChild(uiElements.wrapper);
    this.activeRoutes.push({ id, nodes: audioNodes, ui: uiElements, audioEl });

    // Auto-select first non-default device to avoid feedback
    const firstNonDefault = this.availableDevices.find(
      (d) => d.deviceId !== "default"
    );
    if (firstNonDefault) {
      uiElements.deviceSelect.value = firstNonDefault.deviceId;
    }
    uiElements.deviceSelect.dispatchEvent(new Event("change"));

    this.updateUiState();
  },

  // --- HELPER FUNCTIONS ---

  /**
   * Loads the custom AudioWorklet processor from its own file.
   */
  async ensureWorkletLoaded() {
    if (!this.audioContext || this.audioContext._limiterLoaded) return;
    try {
      await this.audioContext.audioWorklet.addModule("limiter-processor.js");
      this.audioContext._limiterLoaded = true;
    } catch (e) {
      console.error("Failed to load AudioWorklet processor:", e);
      this.elements.warn.textContent =
        'Critical component "limiter-processor.js" failed to load. Check that the file exists and is accessible.';
      throw new Error("Worklet failed to load.");
    }
  },

  /**
   * Fetches and displays available audio output devices.
   */
  async refreshDevices() {
    try {
      this.availableDevices = (
        await navigator.mediaDevices.enumerateDevices()
      ).filter((d) => d.kind === "audiooutput");
      if (
        this.availableDevices.length > 0 &&
        !this.availableDevices.some((d) => d.label?.trim())
      ) {
        this.elements.warn.textContent =
          "Tip: Grant microphone permission once to see device names.";
      }
      document.querySelectorAll(".deviceSelect").forEach((select) => {
        const currentVal = select.value;
        select.innerHTML = "";
        this.availableDevices.forEach((device) =>
          select.add(
            new Option(
              device.label || `Device ${device.deviceId}`,
              device.deviceId
            )
          )
        );
        select.value = currentVal;
      });
    } catch (e) {
      this.elements.warn.textContent =
        "Could not get audio devices. Use a secure (https) Chromium browser.";
    }
  },

  /**
   * Creates the Web Audio API graph for a single route.
   */
  createAudioGraphForRoute() {
    const gainNode = this.audioContext.createGain();
    const delayNode = this.audioContext.createDelay(2.0);
    const hpFilterNode = this.audioContext.createBiquadFilter();
    hpFilterNode.type = "highpass";
    hpFilterNode.frequency.value = 40;
    const limiterNode = new AudioWorkletNode(
      this.audioContext,
      "limiter-processor",
      {
        parameterData: { preGain: 1.0, threshold: 0.96, release: 0.01 },
      }
    );
    const destinationNode = this.audioContext.createMediaStreamDestination();
    this.sourceNode
      .connect(gainNode)
      .connect(delayNode)
      .connect(hpFilterNode)
      .connect(limiterNode)
      .connect(destinationNode);
    return { gainNode, delayNode, hpFilterNode, limiterNode, destinationNode };
  },

  /**
   * Binds all necessary event listeners to a newly created route card's UI elements.
   */
  bindRouteCardEvents(id, audioNodes, uiElements, audioEl) {
    uiElements.deviceSelect.onchange = async () => {
      const deviceId = uiElements.deviceSelect.value;
      if (
        !uiElements.allowDefaultCheck.checked &&
        this.config.echoGuard &&
        (deviceId === "default" || deviceId === "")
      ) {
        this.elements.warn.textContent =
          "Default sink is guarded to prevent echo. Tick the checkbox to override.";
        return;
      }
      try {
        await audioEl.setSinkId(deviceId);
      } catch (e) {
        this.elements.warn.textContent = "Could not switch to the selected device.";
      }
    };
    uiElements.allowDefaultCheck.onchange = () =>
      uiElements.deviceSelect.dispatchEvent(new Event("change"));

    uiElements.gainSlider.oninput = (e) =>
      (audioNodes.gainNode.gain.value = e.target.value / 100);
    uiElements.delayInput.oninput = (e) =>
      (audioNodes.delayNode.delayTime.value = Math.min(
        2,
        Math.max(0, Number(e.target.value) / 1000)
      ));
    uiElements.preGainSlider.oninput = (e) =>
      (audioNodes.limiterNode.parameters.get("preGain").value =
        Number(e.target.value) / 100);
    uiElements.hipassInput.oninput = (e) =>
      (audioNodes.hpFilterNode.frequency.value = Math.min(
        200,
        Math.max(20, Number(e.target.value) || 40)
      ));

    uiElements.playBtn.onclick = () =>
      audioEl.play().catch((e) => {
        this.elements.warn.textContent =
          "Browser blocked playback. Click the play button again.";
      });
    uiElements.pauseBtn.onclick = () => audioEl.pause();

    audioEl.onplay = () => uiElements.wrapper.classList.add("is-playing");
    audioEl.onpause = () => uiElements.wrapper.classList.remove("is-playing");

    uiElements.removeBtn.onclick = () => {
      const routeIndex = this.activeRoutes.findIndex((r) => r.id === id);
      if (routeIndex > -1) {
        this.activeRoutes[routeIndex].audioEl.pause();
        Object.values(this.activeRoutes[routeIndex].nodes).forEach((node) =>
          node.disconnect()
        );
        this.activeRoutes.splice(routeIndex, 1);
      }
      uiElements.wrapper.remove();
      this.updateUiState();
    };

    audioNodes.limiterNode.port.onmessage = (ev) => {
      uiElements.vuBar.style.width = `${Math.min(
        100,
        Math.sqrt(ev.data?.rms ?? 0) * 150
      )}%`;
    };
  },

  /**
   * Builds the DOM elements for a route card.
   */
  buildRouteCard(id) {
    const doc = new DOMParser().parseFromString(
      `
      <li class="route-card" id="route-${id}">
        <h2>🔊 Route</h2>
        <label>
          Device
          <select class="deviceSelect"></select>
        </label>
        <div class="controls-grid">
          <label>Gain <input type="range" min="0" max="200" value="100" class="gainSlider"></label>
          <label>Delay (ms) <input type="number" min="0" max="2000" value="0" class="delayInput"></label>
          <label>Pre-Gain <input type="range" min="50" max="200" value="100" class="preGainSlider"></label>
          <label>Hi-Pass (Hz) <input type="number" min="20" max="200" value="40" class="hipassInput"></label>
        </div>
        <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
          <input type="checkbox" class="allowDefaultCheck">
          <span style="font-size: 0.8rem">Allow default sink (unsafe)</span>
        </label>
        <div class="vu-meter"><div class="vu-bar"></div></div>
        <div class="button-bar">
          <button class="play-btn">▶</button>
          <button class="pause-btn">⏸</button>
          <button class="remove-btn">🗑</button>
        </div>
      </li>
    `,
      "text/html"
    );
    const wrapper = doc.body.firstChild;
    return {
      wrapper,
      deviceSelect: wrapper.querySelector(".deviceSelect"),
      gainSlider: wrapper.querySelector(".gainSlider"),
      delayInput: wrapper.querySelector(".delayInput"),
      preGainSlider: wrapper.querySelector(".preGainSlider"),
      hipassInput: wrapper.querySelector(".hipassInput"),
      allowDefaultCheck: wrapper.querySelector(".allowDefaultCheck"),
      vuBar: wrapper.querySelector(".vu-bar"),
      playBtn: wrapper.querySelector(".play-btn"),
      pauseBtn: wrapper.querySelector(".pause-btn"),
      removeBtn: wrapper.querySelector(".remove-btn"),
    };
  },
};

// Start the application.
app.init();