/**
 * VoiceAssistant.js - Versión con botón flotante de micrófono
 * 
 * Características:
 * - Botón flotante de micrófono (presiona para grabar, vuelve a presionar para enviar)
 * - Detección de ruido externo en tiempo real
 * - Acumulación real de texto
 * - Alerta por inactividad
 * - Feedback visual del nivel de ruido
 */

class VoiceAssistant {
  constructor() {
    // Elementos del DOM
    this.chatArea = document.getElementById('chatArea');
    this.startBtn = document.getElementById('startBtn');
    this.stopBtn = document.getElementById('stopBtn');
    this.saveBtn = document.getElementById('saveBtn');
    this.realtimeBtn = document.getElementById('realtimeBtn');
    this.status = document.getElementById('status');

    // Estado
    this.conversationId = null;
    this.listening = false;
    this.manualRecordingActive = false;
    this.conversationActive = false;
    this.isSpeaking = false;

    // Componentes de voz
    this.recognition = null;
    this.audioContext = null;

    // Variables para acumulación
    this.fullTranscript = '';
    this.lastFinalIndex = 0;
    this.sendTimeout = null;
    this.pauseDelay = 2500; // 2.5 segundos de pausa para enviar

    // Detección de ruido
    this.noiseStream = null;
    this.noiseAudioContext = null;
    this.noiseAnalyser = null;
    this.noiseDataArray = null;
    this.noiseCheckInterval = null;
    this.currentNoiseLevel = 0;
    this.highNoiseCount = 0;
    this.noiseThreshold = 0.25;

    // Inactividad
    this.inactivityTimeout = null;
    this.inactivityDelay = 15000; // 15 segundos

    // Socket
    this.socket = null;

    // Control de errores
    this.noSpeechCount = 0;

    this.init();
    this.createMicButton();
  }

  init() {
    this.initSpeechRecognition();
    this.initSpeechSynthesis();
    this.initSocketIO();
    this.bindEvents();
    this.bindNoiseControls();
    this.checkBrowserSupport();
  }

  /** Vincula controles del medidor de ruido que están en la plantilla */
  bindNoiseControls() {
    try {
      const levelSlider = document.getElementById('levelThreshold');
      const levelValue = document.getElementById('levelThresholdValue') || document.getElementById('levelThresholdVal');
      const levelMeterFill = document.getElementById('levelMeterFill');
      const levelMeterValue = document.getElementById('levelMeterValue');
      const calibrateBtn = document.getElementById('calibrateBtn');

      if (levelSlider) {
        // inicializar valor
        levelSlider.value = this.noiseThreshold;
        if (levelValue) levelValue.textContent = parseFloat(levelSlider.value).toFixed(3);

        levelSlider.addEventListener('input', (e) => {
          const v = parseFloat(e.target.value);
          this.noiseThreshold = v;
          if (levelValue) levelValue.textContent = v.toFixed(3);
        });
      }

      if (calibrateBtn) {
        calibrateBtn.addEventListener('click', async () => {
          try {
            calibrateBtn.disabled = true;
            calibrateBtn.textContent = 'Calibrando...';
            const measured = await this.calibrateNoise(3000);
            // Fijar umbral un 20% por encima del nivel medido
            const newThreshold = Math.max(0.002, measured * 1.2);
            this.noiseThreshold = newThreshold;
            if (levelSlider) levelSlider.value = newThreshold;
            if (levelValue) levelValue.textContent = newThreshold.toFixed(3);
            this.showSystemMessage(`Calibración completa. Umbral: ${newThreshold.toFixed(3)}`);
          } catch (err) {
            console.error('Calibración fallida', err);
            this.showSystemMessage('Calibración fallida');
          } finally {
            calibrateBtn.disabled = false;
            calibrateBtn.textContent = 'Calibrar';
          }
        });
      }

      // Guardar referencias si existen
      if (levelMeterFill) this.levelMeterFill = levelMeterFill;
      if (levelMeterValue) this.levelMeterValue = levelMeterValue;

    } catch (e) {
      console.warn('bindNoiseControls error', e);
    }
  }

  /** Calibra el ruido durante `ms` milisegundos y devuelve el nivel promedio medido */
  async calibrateNoise(ms = 3000) {
    // Asegurarse de tener stream
    if (!this.noiseStream) {
      try {
        await this.startNoiseDetection();
      } catch (e) {
        throw e;
      }
    }

    return new Promise((resolve, reject) => {
      try {
        const samples = [];
        const interval = setInterval(() => {
          if (this.noiseAnalyser && this.noiseDataArray) {
            this.noiseAnalyser.getByteFrequencyData(this.noiseDataArray);
            let sum = 0;
            for (let i = 0; i < this.noiseDataArray.length; i++) {
              sum += this.noiseDataArray[i] / 255;
            }
            samples.push(sum / this.noiseDataArray.length);
          }
        }, 200);

        setTimeout(() => {
          clearInterval(interval);
          if (samples.length === 0) return reject(new Error('No samples'));
          const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
          resolve(avg);
        }, ms);
      } catch (err) {
        reject(err);
      }
    });
  }

  /** Crea el botón flotante de micrófono */
  createMicButton() {
    // Contenedor del botón
    const micContainer = document.createElement('div');
    micContainer.id = 'micButtonContainer';
    micContainer.style.cssText = `
      position: fixed;
      bottom: 30px;
      right: 30px;
      z-index: 10000;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
    `;

    // Botón micrófono
    const micBtn = document.createElement('button');
    micBtn.id = 'micButton';
    micBtn.innerHTML = '🎤';
    micBtn.disabled = true;
    micBtn.style.cssText = `
      width: 60px;
      height: 60px;
      border-radius: 50%;
      border: 3px solid #1976d2;
      background: linear-gradient(135deg, #42a5f5, #1976d2);
      color: white;
      font-size: 28px;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
      transition: all 0.3s ease;
      display: flex;
      align-items: center;
      justify-content: center;
    `;

    // Estados del botón
    micBtn.addEventListener('mouseover', (e) => {
      if (!e.target.disabled) {
        e.target.style.transform = 'scale(1.1)';
        e.target.style.boxShadow = '0 6px 16px rgba(0, 0, 0, 0.4)';
      }
    });

    micBtn.addEventListener('mouseout', (e) => {
      e.target.style.transform = 'scale(1)';
      e.target.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.3)';
    });

    // Click en botón de micrófono
    micBtn.addEventListener('click', () => {
      if (!this.manualRecordingActive) {
        this.startManualRecording();
      } else {
        this.stopManualRecording();
      }
    });

    // Estado del micrófono
    const micState = document.createElement('div');
    micState.id = 'micState';
    micState.style.cssText = `
      background: white;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 12px;
      font-weight: bold;
      color: #666;
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
      min-width: 120px;
      text-align: center;
      opacity: 0;
      transition: opacity 0.3s ease;
    `;

    // Medidor de ruido
    const noiseContainer = document.createElement('div');
    noiseContainer.style.cssText = `
      width: 60px;
      height: 6px;
      background: #e0e0e0;
      border-radius: 3px;
      overflow: hidden;
      opacity: 0.7;
    `;

    const noiseFill = document.createElement('div');
    noiseFill.id = 'noiseMeterFill';
    noiseFill.style.cssText = `
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, #4caf50, #8bc34a);
      transition: width 0.2s ease;
    `;

    noiseContainer.appendChild(noiseFill);

    micContainer.appendChild(micBtn);
    micContainer.appendChild(micState);
    micContainer.appendChild(noiseContainer);

    document.body.appendChild(micContainer);

    this.micBtn = micBtn;
    this.micState = micState;
    this.noiseFill = noiseFill;
  }

  /** Actualiza estado visual del botón */
  updateMicButtonState(state) {
    const states = {
      ready: { text: '✓ Listo', color: '#4caf50' },
      recording: { text: '● Grabando...', color: '#f44336' },
      processing: { text: '⟳ Procesando...', color: '#ff9800' },
      disabled: { text: 'Iniciando...', color: '#ccc' }
    };

    const stateData = states[state] || states.ready;

    this.micState.textContent = stateData.text;
    this.micState.style.color = stateData.color;
    this.micState.style.opacity = '1';

    if (state === 'recording') {
      this.micBtn.style.background = 'linear-gradient(135deg, #f44336, #e91e63)';
      this.micBtn.style.borderColor = '#f44336';
      this.micBtn.innerHTML = '● 🎤';
      this.micBtn.style.animation = 'pulse 1.5s infinite';
    } else if (state === 'processing') {
      this.micBtn.style.background = 'linear-gradient(135deg, #ff9800, #ffc107)';
      this.micBtn.style.borderColor = '#ff9800';
      this.micBtn.innerHTML = '⟳ 🎤';
    } else {
      this.micBtn.style.background = 'linear-gradient(135deg, #42a5f5, #1976d2)';
      this.micBtn.style.borderColor = '#1976d2';
      this.micBtn.innerHTML = '🎤';
      this.micBtn.style.animation = 'none';
    }
  }

  /** Inicia detección de ruido REAL */
  async startNoiseDetection() {
    try {
      console.log('Iniciando detección de ruido...');

      this.noiseStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      });

      this.noiseAudioContext = new (window.AudioContext || window.webkitAudioContext)();
      const source = this.noiseAudioContext.createMediaStreamSource(this.noiseStream);

      this.noiseAnalyser = this.noiseAudioContext.createAnalyser();
      this.noiseAnalyser.fftSize = 2048;
      this.noiseAnalyser.smoothingTimeConstant = 0.8;

      source.connect(this.noiseAnalyser);

      this.noiseDataArray = new Uint8Array(this.noiseAnalyser.frequencyBinCount);

      this.noiseCheckInterval = setInterval(() => {
        this.analyzeNoise();
      }, 300);

      console.log('Detección de ruido activa');

    } catch (error) {
      console.error('Error en detección de ruido:', error);
    }
  }

  /** Analiza el nivel de ruido REAL */
  analyzeNoise() {
    if (!this.noiseAnalyser || !this.noiseDataArray) return;

    this.noiseAnalyser.getByteFrequencyData(this.noiseDataArray);

    let sum = 0;
    let peakCount = 0;

    for (let i = 0; i < this.noiseDataArray.length; i++) {
      const normalized = this.noiseDataArray[i] / 255;
      sum += normalized;

      if (normalized > 0.6) {
        peakCount++;
      }
    }

    const average = sum / this.noiseDataArray.length;
    const peakRatio = peakCount / this.noiseDataArray.length;

    this.currentNoiseLevel = average;

    // Actualizar medidor
    this.updateNoiseUI(average, peakRatio);

    // Detectar ruido excesivo
    if (average > this.noiseThreshold || peakRatio > 0.15) {
      this.highNoiseCount++;

      if (this.highNoiseCount >= 5) {
        this.onHighNoise();
        this.highNoiseCount = 0;
      }
    } else {
      if (this.highNoiseCount > 0) {
        this.highNoiseCount--;
      }
    }
  }

  /** Actualiza UI del medidor de ruido */
  updateNoiseUI(level, peakRatio) {
    const percentage = Math.min(100, level * 100);

    // Fill en botón flotante
    if (this.noiseFill) {
      this.noiseFill.style.width = `${percentage}%`;
      if (level > this.noiseThreshold || peakRatio > 0.15) {
        this.noiseFill.style.background = 'linear-gradient(90deg, #f44336, #e91e63)';
      } else if (level > this.noiseThreshold * 0.6) {
        this.noiseFill.style.background = 'linear-gradient(90deg, #ff9800, #ffc107)';
      } else {
        this.noiseFill.style.background = 'linear-gradient(90deg, #4caf50, #8bc34a)';
      }
    }

    // Sincronizar con medidor en la plantilla principal si existe
    try {
      const mainFill = document.getElementById('levelMeterFill');
      const mainVal = document.getElementById('levelMeterValue');
      if (mainFill) {
        mainFill.style.width = `${percentage}%`;
        if (level > this.noiseThreshold || peakRatio > 0.15) {
          mainFill.style.background = 'linear-gradient(90deg,#f44336,#e91e63)';
        } else if (level > this.noiseThreshold * 0.6) {
          mainFill.style.background = 'linear-gradient(90deg,#ff9800,#ffc107)';
        } else {
          mainFill.style.background = 'linear-gradient(90deg,#4caf50,#8bc34a)';
        }
      }
      if (mainVal) mainVal.textContent = level.toFixed(3);
    } catch (e) { }
  }

  /** Cuando se detecta ruido alto sostenido */
  onHighNoise() {
    console.warn('ALERTA: Ruido excesivo detectado');

    this.addMessage(
      'system',
      '⚠️ HAY MUCHO RUIDO DE FONDO:\n• Ve a un lugar más silencioso\n• Acércate al micrófono\n• Aleja fuentes de ruido'
    );

    if (!this.isSpeaking && this.conversationActive) {
      this.speak('Detecto mucho ruido de fondo. Por favor ve a un lugar más silencioso.');
    }
  }

  /** Detiene la detección de ruido */
  stopNoiseDetection() {
    if (this.noiseCheckInterval) {
      clearInterval(this.noiseCheckInterval);
      this.noiseCheckInterval = null;
    }

    if (this.noiseStream) {
      this.noiseStream.getTracks().forEach(track => track.stop());
      this.noiseStream = null;
    }

    if (this.noiseAudioContext) {
      this.noiseAudioContext.close().catch(e => { });
      this.noiseAudioContext = null;
    }

    this.noiseAnalyser = null;
    this.noiseDataArray = null;
    this.highNoiseCount = 0;
  }

  initSpeechRecognition() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

    if (!SpeechRecognition) {
      this.showSystemMessage('Tu navegador no soporta reconocimiento de voz.');
      return;
    }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = 'es-CO';

    // Acumular TODO sin perder contexto
    this.recognition.onresult = (event) => {
      this.resetInactivityTimer();

      let interimText = '';
      let newFinalText = '';

      for (let i = this.lastFinalIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript;

        if (result.isFinal) {
          newFinalText += text + ' ';
          this.lastFinalIndex = i + 1;
          console.log('FINAL:', text);
        } else {
          interimText += text;
          console.log('INTERIM:', text);
        }
      }

      if (newFinalText) {
        this.fullTranscript += newFinalText;
        console.log('TRANSCRIPCIÓN ACUMULADA:', this.fullTranscript);
        this.showAccumulatedText();
        this.resetSendTimeout();
      }

      if (interimText) {
        this.showInterimText(interimText);
      }
    };

    this.recognition.onerror = (event) => {
      console.error('Error reconocimiento:', event.error);

      if (event.error === 'no-speech') {
        this.noSpeechCount++;

        if (this.noSpeechCount >= 3) {
          this.addMessage(
            'system',
            '🔇 No te escucho bien:\n• Verifica que tu micrófono funcione\n• Habla cerca del micrófono\n• Revisa el volumen'
          );

          if (!this.isSpeaking) {
            this.speak('No te escucho bien. Verifica que tu micrófono funcione.');
          }

          this.noSpeechCount = 0;
        }
      } else if (event.error === 'audio-capture') {
        this.addMessage('system', '❌ No se puede acceder al micrófono. Verifica los permisos.');
      } else if (event.error === 'not-allowed') {
        this.addMessage('system', '❌ Permiso denegado. Permite el acceso al micrófono.');
      }
    };

    this.recognition.onend = () => {
      console.log('Reconocimiento finalizado');
      this.listening = false;

      if (this.manualRecordingActive) {
        console.log('Grabación manual finalizada, esperar envío...');
      }
    };

    this.recognition.onstart = () => {
      console.log('Reconocimiento iniciado');
      this.listening = true;
      this.lastFinalIndex = 0;
      this.updateStatus('Escuchando...', 'blue');
      this.resetInactivityTimer();
    };
  }

  /** Reinicia el timeout para enviar */
  resetSendTimeout() {
    if (this.sendTimeout) {
      clearTimeout(this.sendTimeout);
    }

    // Solo auto-enviar si NO está en modo manual
    if (!this.manualRecordingActive) {
      this.sendTimeout = setTimeout(() => {
        if (this.fullTranscript.trim()) {
          console.log('Timeout alcanzado, enviando...');
          this.sendFullTranscript();
        }
      }, this.pauseDelay);
    }
  }

  /** Envía la transcripción completa acumulada */
  sendFullTranscript() {
    const text = this.fullTranscript.trim();

    if (!text) {
      console.log('No hay texto para enviar');
      return;
    }

    console.log('ENVIANDO:', text);

    this.addMessage('user', text);
    this.clearTemporaryDisplays();
    this.sendToServer(text);

    this.fullTranscript = '';
    this.lastFinalIndex = 0;
    this.noSpeechCount = 0;

    if (this.sendTimeout) {
      clearTimeout(this.sendTimeout);
    }
  }

  /** Muestra el texto acumulado hasta ahora */
  showAccumulatedText() {
    let draftDiv = document.querySelector('.draft-message');

    if (!draftDiv) {
      draftDiv = document.createElement('div');
      draftDiv.className = 'message draft-message';
      this.chatArea.appendChild(draftDiv);
    }

    draftDiv.innerHTML = `<p class="message-content" style="background:#e3f2fd; padding:10px; border-radius:6px;"><strong>📝 Acumulando:</strong> ${this.fullTranscript}</p>`;
    this.chatArea.scrollTop = this.chatArea.scrollHeight;
  }

  /** Muestra texto interim (temporal) */
  showInterimText(text) {
    let interimDiv = document.querySelector('.interim-message');

    if (!interimDiv) {
      interimDiv = document.createElement('div');
      interimDiv.className = 'message interim-message';
      this.chatArea.appendChild(interimDiv);
    }

    interimDiv.innerHTML = `<p class="message-content" style="opacity:0.6; font-style:italic;">💬 ${text}...</p>`;
    this.chatArea.scrollTop = this.chatArea.scrollHeight;
  }

  /** Limpia displays temporales */
  clearTemporaryDisplays() {
    const draftDiv = document.querySelector('.draft-message');
    if (draftDiv) draftDiv.remove();

    const interimDiv = document.querySelector('.interim-message');
    if (interimDiv) interimDiv.remove();
  }

  /** Reinicia timer de inactividad */
  resetInactivityTimer() {
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
    }

    this.inactivityTimeout = setTimeout(() => {
      if (this.conversationActive && !this.isSpeaking) {
        console.log('INACTIVIDAD: Sin voz por 15 segundos');

        this.addMessage('system', '❓ ¿Sigues ahí? No te he escuchado en un rato.');

        if (!this.isSpeaking) {
          this.speak('¿Sigues ahí? No te he escuchado.');
        }

        this.resetInactivityTimer();
      }
    }, this.inactivityDelay);
  }

  /** Limpia timer de inactividad */
  clearInactivityTimer() {
    if (this.inactivityTimeout) {
      clearTimeout(this.inactivityTimeout);
      this.inactivityTimeout = null;
    }
  }

  initSpeechSynthesis() {
    if (!window.speechSynthesis) {
      this.showSystemMessage('Síntesis de voz no disponible.');
      return;
    }

    this.voices = [];
    this.loadVoices();
    window.speechSynthesis.onvoiceschanged = () => this.loadVoices();
  }

  loadVoices() {
    this.voices = window.speechSynthesis.getVoices();
    const spanishVoices = this.voices.filter(v => v.lang.includes('es'));
    this.spanishVoice = spanishVoices[0] || null;
  }

  initSocketIO() {
    try {
      this.socket = io({
        reconnection: true,
        reconnectionAttempts: 5
      });

      this.socket.on('connect', () => {
        console.log('Socket conectado');
        this.updateStatus('Conectado', 'green');
      });

      this.socket.on('disconnect', () => {
        console.log('Socket desconectado');
      });

    } catch (error) {
      console.error('Error Socket.IO:', error);
    }
  }

  bindEvents() {
    this.startBtn.addEventListener('click', () => this.startConversation());
    this.stopBtn.addEventListener('click', () => this.stopConversation());
    this.saveBtn.addEventListener('click', () => this.saveConversation());
    this.realtimeBtn.addEventListener('click', () => this.connectOpenAIRealtime());
  }

  /** Inicia grabación manual (presionar botón micrófono) */
  startManualRecording() {
    if (!this.recognition) {
      this.showSystemMessage('Reconocimiento no disponible.');
      return;
    }

    if (this.listening) {
      console.log('Ya se está escuchando');
      return;
    }

    this.fullTranscript = '';
    this.lastFinalIndex = 0;
    this.manualRecordingActive = true;

    this.updateMicButtonState('recording');
    this.micBtn.disabled = false;

    try {
      this.recognition.start();
      this.updateStatus('🎤 Grabando...', 'red');
    } catch (e) {
      console.error('Error al iniciar:', e);
      this.showSystemMessage('No se pudo iniciar la grabación.');
      this.manualRecordingActive = false;
      this.updateMicButtonState('ready');
    }
  }

  /** Detiene grabación manual y envía (presionar botón de nuevo) */
  stopManualRecording() {
    if (!this.manualRecordingActive) return;

    this.updateMicButtonState('processing');
    this.micBtn.disabled = true;

    this.manualRecordingActive = false;

    try {
      this.recognition.stop();
    } catch (e) {
      console.warn('stop failed', e);
    }

    // Esperar a que onresult se procese
    setTimeout(() => {
      if (this.fullTranscript && this.fullTranscript.trim()) {
        this.sendFullTranscript();
      } else {
        this.showSystemMessage('No se detectó voz. Intenta de nuevo.');
        this.updateMicButtonState('ready');
        this.micBtn.disabled = false;
      }

      this.updateStatus('Espera respuesta...', 'orange');
    }, 300);
  }

  checkBrowserSupport() {
    const missing = [];
    if (!window.SpeechRecognition && !window.webkitSpeechRecognition) {
      missing.push('Reconocimiento de voz');
    }
    if (!window.speechSynthesis) {
      missing.push('Síntesis de voz');
    }
    if (missing.length > 0) {
      this.showSystemMessage(`⚠️ No disponible: ${missing.join(', ')}`);
    }
  }

  async startConversation() {
    try {
      this.startBtn.disabled = true;
      this.updateStatus('Iniciando...', 'orange');

      // Iniciar detección de ruido
      await this.startNoiseDetection();

      const response = await fetch('/api/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      if (data.error) throw new Error(data.error);

      this.conversationId = data.conversation_id;
      this.addMessage('assistant', data.message);
      this.speak(data.message);

      this.conversationActive = true;
      this.stopBtn.disabled = false;
      this.saveBtn.disabled = false;
      this.realtimeBtn.disabled = false;

      // Habilitar botón de micrófono
      this.micBtn.disabled = false;
      this.updateMicButtonState('ready');

      setTimeout(() => {
        if (!this.isSpeaking) {
          this.updateStatus('Listo para grabar', 'green');
        }
      }, 1500);

      console.log('Conversación iniciada');

    } catch (error) {
      console.error('Error:', error);
      this.showSystemMessage(`❌ Error: ${error.message}`);
      this.startBtn.disabled = false;
    }
  }

  stopConversation() {
    if (this.fullTranscript.trim()) {
      this.sendFullTranscript();
    }

    if (this.listening) {
      this.recognition.stop();
    }

    this.stopNoiseDetection();
    this.clearInactivityTimer();

    this.conversationActive = false;
    this.startBtn.disabled = false;
    this.stopBtn.disabled = true;
    this.saveBtn.disabled = true;
    this.realtimeBtn.disabled = true;
    this.micBtn.disabled = true;

    this.updateStatus('Finalizada', 'red');
    this.showSystemMessage('Conversación finalizada.');

    if (this.conversationId) {
      this.saveConversation();
    }
  }

  async sendToServer(userMessage) {
    if (!this.conversationId) return;

    try {
      const response = await fetch('/api/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversation_id: this.conversationId,
          message: userMessage
        })
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data = await response.json();
      if (data.error) throw new Error(data.error);

      this.addMessage('assistant', data.message);
      this.speak(data.message);

      if (data.conversation_complete) {
        this.completeConversation();
      } else {
        // Preparar para siguiente grabación
        setTimeout(() => {
          this.updateMicButtonState('ready');
          this.micBtn.disabled = false;
          this.updateStatus('Listo para grabar', 'green');
        }, 500);
      }

    } catch (error) {
      console.error('Error:', error);
      this.showSystemMessage('❌ Error al procesar.');
      this.updateMicButtonState('ready');
      this.micBtn.disabled = false;
    }
  }

  completeConversation() {
    this.stopConversation();
    this.showSystemMessage('✅ Conversación completada. Gracias.');
  }

  async connectOpenAIRealtime() {
    this.showSystemMessage('Conectando con OpenAI Realtime...');
  }

  speak(text) {
    console.log('Hablando:', text.substring(0, 50));

    if (this.listening) {
      this.recognition.stop();
    }

    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'es-ES';
    utterance.rate = 1.0;
    utterance.volume = 0.9;

    if (this.spanishVoice) {
      utterance.voice = this.spanishVoice;
    }

    utterance.onstart = () => {
      this.isSpeaking = true;
      this.updateStatus('Hablando...', 'blue');
      this.micBtn.disabled = true;
    };

    utterance.onend = () => {
      console.log('TTS finalizado');
      this.isSpeaking = false;
      this.updateStatus('Listo para grabar', 'green');
      this.updateMicButtonState('ready');
      this.micBtn.disabled = false;
    };

    utterance.onerror = () => {
      this.isSpeaking = false;
      this.updateMicButtonState('ready');
      this.micBtn.disabled = false;
    };

    window.speechSynthesis.cancel();
    setTimeout(() => window.speechSynthesis.speak(utterance), 100);
  }

  addMessage(role, content) {
    const div = document.createElement('div');
    div.className = `message ${role}`;
    div.innerHTML = `
      <p class="message-content">${content}</p>
      <div class="message-timestamp">${new Date().toLocaleTimeString('es-ES')}</div>
    `;
    this.chatArea.appendChild(div);
    this.chatArea.scrollTop = this.chatArea.scrollHeight;
  }

  showSystemMessage(content) {
    const div = document.createElement('div');
    div.className = 'message system';
    div.innerHTML = `<p class="message-content">${content}</p>`;
    this.chatArea.appendChild(div);
    this.chatArea.scrollTop = this.chatArea.scrollHeight;
  }

  updateStatus(message, color) {
    this.status.textContent = `Estado: ${message}`;
    this.status.style.color = color;
  }

  async saveConversation() {
    if (!this.conversationId) return;

    try {
      const response = await fetch('/api/save_manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: this.conversationId })
      });

      const data = await response.json();
      this.showSystemMessage(data.message);

    } catch (error) {
      console.error('Error guardando:', error);
    }
  }

  destroy() {
    if (this.listening) {
      this.recognition.stop();
    }

    this.stopNoiseDetection();
    this.clearInactivityTimer();

    if (window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }

    if (this.socket) {
      this.socket.disconnect();
    }
  }
}

// Agregar animación de pulso en CSS
const style = document.createElement('style');
style.textContent = `
  @keyframes pulse {
    0%, 100% {
      transform: scale(1);
    }
    50% {
      transform: scale(1.05);
    }
  }

  #micButtonContainer {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
  }

  .draft-message p, .interim-message p {
    word-break: break-word;
  }

  .message.draft-message {
    background-color: #f0f4ff;
    border-left: 4px solid #1976d2;
  }

  .message.interim-message {
    background-color: #f9f9f9;
    border-left: 4px solid #999;
  }
`;
document.head.appendChild(style);

// Inicialización
document.addEventListener('DOMContentLoaded', () => {
  try {
    window.voiceAssistant = new VoiceAssistant();

    window.addEventListener('beforeunload', () => {
      if (window.voiceAssistant) {
        window.voiceAssistant.destroy();
      }
    });

    console.log('VoiceAssistant inicializado correctamente');

  } catch (error) {
    console.error('Error inicializando:', error);
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = `
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: #f8d7da;
      color: #721c24;
      padding: 20px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
      z-index: 10001;
      font-family: Arial, sans-serif;
      text-align: center;
    `;
    errorDiv.innerHTML = `
      <h3>Error de Inicialización</h3>
      <p>${error.message}</p>
    `;
    document.body.appendChild(errorDiv);
  }
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = VoiceAssistant;
}