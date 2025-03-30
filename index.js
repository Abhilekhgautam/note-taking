window.addEventListener("DOMContentLoaded", () => {
  const recordBtn = document.getElementById("recordButton");
  const statusDisplay = document.getElementById("status");
  const transcriptOutput = document.getElementById("transcriptionText");

  const WEBSOCKET_URL =
    "wss://go-speech-backend-603247174030.us-central1.run.app/ws";

  let socket;
  let mediaRecorder;
  let localStream;
  let isRecording = false;
  let speakerMap = {}; // To map speaker tags (like 1, 2) to labels (Doctor, Patient)
  let nextSpeakerIndex = 0;

  function connectWebSocket() {
    statusDisplay.textContent = "Status: Connecting to server...";
    socket = new WebSocket(WEBSOCKET_URL);

    socket.onopen = () => {
      console.log("WebSocket Connected");
      statusDisplay.textContent = "Status: Connected. Ready to record.";
      recordBtn.disabled = false;
    };

    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        console.log("Message from server:", message);

        if (message.transcript && message.isFinal) {
          displayTranscript(message.transcript, message.speakerTag);
        }
        // Add handling for interim results if your backend sends them
        // if (message.transcript && !message.isFinal) {
        //    displayInterimTranscript(message.transcript, message.speakerTag);
        // }
      } catch (error) {
        console.error(
          "Failed to parse message or invalid message format:",
          event.data,
          error,
        );
      }
    };

    socket.onerror = (error) => {
      console.error("WebSocket Error:", error);
      statusDisplay.textContent =
        "Status: Connection error. Please check backend.";
      recordBtn.disabled = true;
      isRecording = false; // Ensure state is reset
      cleanupRecording();
    };

    socket.onclose = (event) => {
      console.log("WebSocket Closed:", event.reason);
      statusDisplay.textContent = `Status: Disconnected (${event.reason || "No reason specified"})`;
      recordBtn.disabled = true;
      recordBtn.textContent = "Start Recording";
      recordBtn.classList.remove("recording");
      isRecording = false;
      cleanupRecording();
      //try to reconnect?
      setTimeout(connectWebSocket, 5000); // Simple reconnect attempt
    };
  }

  function getSpeakerLabel(tag) {
    if (!(tag in speakerMap)) {
      // Simple assignment: first speaker is Doctor, second is Patient
      // A more robust app might let the user assign these.
      speakerMap[tag] = nextSpeakerIndex === 0 ? "speakerA" : `speakerB`;
      // speakerMap[tag] = `Speaker ${tag}`; // Generic fallback
      nextSpeakerIndex++;
    }
    return speakerMap[tag];
  }

  function displayTranscript(text, speakerTag) {
    const speakerLabel = getSpeakerLabel(speakerTag);
    const line = document.createElement("div");
    line.classList.add("transcript-line");

    const speakerSpan = document.createElement("span");
    speakerSpan.classList.add("speaker-label", `speaker-${speakerLabel}`); // Add specific class
    speakerSpan.textContent = `${speakerLabel}:`;

    const textNode = document.createTextNode(` ${text}`); // Add space after label

    line.appendChild(speakerSpan);
    line.appendChild(textNode);

    transcriptOutput.appendChild(line);
    // Auto-scroll to the bottom
    transcriptOutput.scrollTop = transcriptOutput.scrollHeight;
  }

  async function startRecording() {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      statusDisplay.textContent = "Status: Not connected to server.";
      return;
    }
    if (isRecording) return;

    statusDisplay.textContent = "Status: Requesting mic permission...";
    speakerMap = {}; // Reset speaker mapping for new session
    nextSpeakerIndex = 0;
    // transcriptOutput.innerHTML = ''; // Clear previous transcript

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
      statusDisplay.textContent = "Status: Mic access granted. Starting...";

      // --- Important: Check Sample Rate and Encoding ---
      // The backend (and Google Cloud) needs to know the exact sample rate.
      // Browsers often default to 48000 or 44100. We need to tell the backend.
      // MediaRecorder doesn't easily expose this *before* recording.
      // For simplicity, we'll assume a common rate (e.g., 48000) and configure
      // the backend accordingly. A more robust solution might involve an
      // AudioContext to analyze the sample rate first.
      const audioContext = new AudioContext();
      const sampleRate = audioContext.sampleRate;
      console.log(`Audio Sample Rate: ${sampleRate}`);
      // Send sample rate info to backend when connection opens or recording starts
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "config", sampleRate: sampleRate }));
      }
      await audioContext.close(); // Close context after getting rate

      mediaRecorder = new MediaRecorder(localStream, {
        // mimeType: 'audio/webm;codecs=opus' // Common, good quality/compression
        // mimeType: 'audio/wav' // Less common in MediaRecorder, large files
        // Let the browser choose default, backend needs to handle it (or request specific)
      });

      mediaRecorder.ondataavailable = (event) => {
        if (
          event.data.size > 0 &&
          socket &&
          socket.readyState === WebSocket.OPEN
        ) {
          // Send buffer directly. Backend needs to handle ArrayBuffer/Blob.
          socket.send(event.data);
        }
      };

      mediaRecorder.onstart = () => {
        isRecording = true;
        statusDisplay.textContent = "Status: Recording...";
        recordBtn.textContent = "Stop Recording";
        recordBtn.classList.add("recording");
        console.log("MediaRecorder started");
      };

      mediaRecorder.onstop = () => {
        console.log("MediaRecorder stopped");
        // No need to explicitly set isRecording = false here,
        // it's handled by the button click or socket close.
      };

      mediaRecorder.onerror = (event) => {
        console.error("MediaRecorder Error:", event.error);
        statusDisplay.textContent = `Status: Recording Error - ${event.error.name}`;
        stopRecording(); // Stop on error
      };

      // How often to chunk the audio (milliseconds)
      // Smaller values = lower latency, more network traffic
      // Larger values = higher latency, less network traffic
      const timeSlice = 500; // 500ms chunks
      mediaRecorder.start(timeSlice);
    } catch (err) {
      console.error("Error starting recording:", err);
      statusDisplay.textContent = `Status: Error - ${err.message}`;
      if (err.name === "NotAllowedError") {
        statusDisplay.textContent = "Status: Microphone permission denied.";
      }
      cleanupRecording();
    }
  }

  function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop(); // This triggers ondataavailable one last time, then onstop
    }
    // Send a specific "end" signal if your backend protocol requires it
    // if (socket && socket.readyState === WebSocket.OPEN) {
    //    socket.send(JSON.stringify({ type: 'endStream' }));
    // }

    cleanupRecording(); // Release mic
    isRecording = false;
    statusDisplay.textContent = "Status: Recording stopped. Ready.";
    recordBtn.textContent = "Start Recording";
    recordBtn.classList.remove("recording");
  }

  function cleanupRecording() {
    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
      localStream = null;
      console.log("Microphone stream stopped.");
    }
    mediaRecorder = null; // Allow garbage collection
  }

  // --- Button Control ---
  recordBtn.onclick = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording(); // Will check socket connection inside
    }
  };

  // --- Initial Connection ---
  recordBtn.disabled = true; // Disable button until connected
  connectWebSocket();
}); // End DOMContentLoaded
