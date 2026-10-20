'use strict';

(() => {
  // A documentação do Mail.gw informa suporte a CORS. Chamamos a API diretamente,
  // evitando que um 502 do proxy Python local impeça a criação da caixa.
  const FILE_MODE = window.location.protocol === 'file:';
  const API = 'https://api.mail.gw';
  const $ = (id) => document.getElementById(id);
  const state = { token: null, accountId: null, address: null, busy: false, messageIds: new Set(), lastRequestAt: 0 };

  const setStatus = (message) => { $('status').textContent = message; };
  const setBusy = (busy) => {
    state.busy = busy;
    ['createBtn', 'refreshBtn', 'deleteBtn', 'copyBtn'].forEach((id) => {
      const el = $(id);
      if (el) el.disabled = busy || (id === 'createBtn' && FILE_MODE) || (id !== 'createBtn' && !state.token);
    });
  };

  async function api(path, options = {}) {
    if (typeof path !== 'string' || !path.startsWith('/api/')) throw new Error('Destino de rede não permitido.');
    const upstreamPath = path.slice(4);
    const url = new URL(upstreamPath, API);
    if (url.origin !== API || url.pathname.startsWith('//')) throw new Error('Destino de rede não permitido.');
    const headers = new Headers(options.headers || {});
    headers.set('Accept', 'application/json');
    if (options.body) headers.set('Content-Type', 'application/json');
    if (state.token && options.auth !== false) headers.set('Authorization', `Bearer ${state.token}`);
    
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 15000);
    let response;
    try {
      response = await fetch(url.href, {
        method: options.method || 'GET',
        headers,
        body: options.body ? JSON.stringify(options.body) : undefined,
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        signal: controller.signal
      });
    } catch (error) {
      if (error && error.name === 'AbortError') throw new Error('A solicitação excedeu 15 segundos e foi cancelada.');
      throw new Error('Não foi possível conectar diretamente à API Mail.gw. Verifique sua internet ou se o provedor está temporariamente indisponível.');
    } finally {
      window.clearTimeout(timeoutId);
    }
    const raw = await response.text();
    if (raw.length > 2 * 1024 * 1024) throw new Error('Resposta muito grande; solicitação interrompida por segurança.');
    let data = {};
    if (raw) {
      try { data = JSON.parse(raw); }
      catch { throw new Error('O serviço retornou uma resposta inesperada.'); }
    }
    if (!response.ok) {
      const safeMessages = {
        400: 'O serviço não aceitou os dados enviados. Confira o nome e tente novamente.',
        401: 'Autenticação recusada pelo serviço.',
        403: 'O serviço recusou a operação. Tente novamente mais tarde.',
        404: 'O recurso não foi encontrado no serviço.',
        409: 'Esse endereço já existe. Tente criar outra caixa.',
        422: 'O serviço não aceitou esse endereço (ele pode já existir ou o domínio pode estar indisponível). Tente novamente.',
        429: 'Muitas solicitações. Aguarde um pouco e tente novamente.',
        500: 'O Mail.gw apresentou um erro interno. Tente novamente mais tarde.',
        502: 'O Mail.gw está temporariamente indisponível (502). Tente novamente mais tarde.',
        503: 'O Mail.gw está em manutenção ou sobrecarregado. Tente novamente mais tarde.',
        504: 'O Mail.gw demorou para responder. Tente novamente.'
      };
      throw new Error(safeMessages[response.status] || `Falha no serviço de e-mail (HTTP ${response.status}).`);
    }
    return data;
  }

  function randomPassword() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  function clearMessages() {
    $('messages').replaceChildren();
    $('count').textContent = '0';
    state.messageIds.clear();
  }

  function addTextMessage(message, bodyText) {
    const card = document.createElement('article');
    card.className = 'message';
    const title = document.createElement('h3');
    title.textContent = String(message.subject || '(Sem assunto)');
    const meta = document.createElement('div');
    meta.className = 'meta';
    const from = message.from && (message.from.address || message.from.name)
      ? `${message.from.name || ''} ${message.from.address ? `<${message.from.address}>` : ''}`.trim()
      : 'Remetente não informado';
    const date = message.createdAt ? new Date(message.createdAt) : null;
    meta.textContent = `De: ${from}${date && !Number.isNaN(date.getTime()) ? ' · ' + date.toLocaleString('pt-BR') : ''}`;
    const body = document.createElement('pre');
    body.className = 'body-text';
    body.textContent = bodyText || 'Esta mensagem não contém texto simples. O conteúdo HTML foi ocultado por segurança.';
    card.append(title, meta, body);
    $('messages').append(card);
  }

  async function createMailbox() {
    if (state.busy) return;
    let created = false;
    setBusy(true);
    setStatus('Consultando domínios disponíveis…');
    try {
      let domains = [];
      let domainError = null;
      try {
        const domainData = await api('/api/domains?page=1', { auth: false });
        domains = Array.isArray(domainData['hydra:member']) ? domainData['hydra:member'] : [];
        domains = domains
          .filter(d => d && typeof d.domain === 'string' && d.domain &&
            d.isActive !== false && d.isPrivate !== true)
          .map(d => d.domain.toLowerCase());
      } catch (err) {
        domainError = err;
        console.warn('Não foi possível consultar a lista de domínios:', err);
      }

      if (!domains.length) {
        if (domainError instanceof Error) {
          throw new Error(`Não foi possível obter domínios do Mail.gw. ${domainError.message}`);
        }
        throw new Error('O Mail.gw respondeu, mas não informou domínios ativos. Tente novamente mais tarde.');
      }
      const password = randomPassword();
      let account = null;
      let address = null;
      let lastCreateError = null;

      for (let attempt = 0; attempt < 6; attempt++) {
        const domain = domains[Math.floor(Math.random() * domains.length)];
        const randomPart = Array.from(
          crypto.getRandomValues(new Uint8Array(7)),
          b => b.toString(16).padStart(2, '0')
        ).join('');
        address = `temp${randomPart}@${domain}`;
        setStatus(`Criando endereço aleatório… (tentativa ${attempt + 1} de 6)`);
        try {
          account = await api('/api/accounts', {
            method: 'POST',
            auth: false,
            body: { address, password }
          });
          break;
        } catch (err) {
          lastCreateError = err;
          // Endereço já ocupado ou domínio rejeitado: gere outro endereço e tente novamente.
          if (!(err instanceof Error) || !/HTTP 409|HTTP 422|já existe|não aceitou/i.test(err.message)) {
            throw err;
          }
        }
      }

      if (!account) {
        throw new Error(
          'O serviço recusou os endereços gerados. Isso pode acontecer quando os domínios públicos estão indisponíveis. Tente novamente mais tarde.' +
          (lastCreateError ? ` (${lastCreateError.message})` : '')
        );
      }

      const tokenData = await api('/api/token', {
        method: 'POST',
        auth: false,
        body: { address, password }
      });

      if (!tokenData.token || !account.id) {
        throw new Error('O serviço criou uma resposta incompleta e não forneceu os dados esperados.');
      }
      state.token = tokenData.token;
      state.accountId = account.id;
      state.address = address;

      $('emailAddress').value = address;
      $('emailAddress').readOnly = true;
      $('mailboxArea').hidden = false;
      clearMessages();
      setStatus('Caixa criada com sucesso! Use Copiar para copiar o endereço.');
      created = true;
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Não foi possível criar a caixa.');
    } finally {
      setBusy(false);
      if (created) await refreshMessages();
    }
  }

  async function refreshMessages() {
    if (!state.token || state.busy) return;
    setBusy(true);
    setStatus('Consultando mensagens…');
    try {
      const data = await api('/api/messages?page=1');
      const messages = Array.isArray(data['hydra:member']) ? data['hydra:member'] : [];
      clearMessages();
      $('count').textContent = String(messages.length);
      if (!messages.length) {
        const p = document.createElement('p');
        p.className = 'muted';
        p.textContent = 'Nenhuma mensagem recebida ainda.';
        $('messages').append(p);
      }
      for (const msg of messages.slice(0, 30)) {
        if (!msg || !msg.id) continue;
        let detail = {};
        try { detail = await api(`/api/messages/${encodeURIComponent(String(msg.id))}`); }
        catch { detail = msg; }
        const textBody = Array.isArray(detail.text) ? detail.text.join('\n') : (typeof detail.text === 'string' ? detail.text : '');
        addTextMessage(detail, textBody);
      }
      setStatus('Consulta concluída. Mensagens exibidas como texto simples.');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : 'Não foi possível consultar as mensagens.');
    } finally {
      setBusy(false);
    }
  }

  async function deleteMailbox() {
    if (!state.token || state.busy) return;
    const confirmed = window.confirm('Deseja tentar excluir esta caixa no serviço externo? Esta ação não pode ser desfeita.');
    if (!confirmed) return;
    setBusy(true);
    setStatus('Tentando excluir a caixa…');
    try {
      await api(`/api/accounts/${encodeURIComponent(String(state.accountId))}`, { method: 'DELETE' });
      setStatus('Solicitação de exclusão enviada ao serviço.');
    } catch (error) {
      setStatus(`Não foi possível confirmar a exclusão no serviço. ${error instanceof Error ? error.message : ''}`.trim());
    } finally {
      state.token = null;
      state.accountId = null;
      state.address = null;
      $('emailAddress').value = '';
      $('mailboxArea').hidden = true;
      clearMessages();
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'Caixa desconectada. A exclusão remota pode não ter sido concluída; confira as regras do provedor.';
      $('messages').append(p);
      setBusy(false);
    }
  }

  $('createBtn').addEventListener('click', createMailbox);
  $('refreshBtn').addEventListener('click', refreshMessages);
  $('deleteBtn').addEventListener('click', deleteMailbox);
  $('copyBtn').addEventListener('click', async () => {
    if (!state.address) return;
    try {
      await navigator.clipboard.writeText(state.address);
      setStatus('Endereço copiado.');
    } catch {
      $('emailAddress').select();
      setStatus('Não foi possível copiar automaticamente. Selecione e copie o endereço manualmente.');
    }
  });

  window.addEventListener('pagehide', () => {
    state.token = null;
    state.accountId = null;
  });

  setBusy(false);
  if (FILE_MODE) {
    setStatus('Para usar a caixa, execute iniciar.bat e abra http://localhost:8000. Não abra index.html diretamente.');
  }
  const adsScript = document.querySelector('script[src*="pagead/js/adsbygoogle.js"]');
  const adSlot = document.querySelector('ins.adsbygoogle');
  if (adsScript && adSlot) {
    const pushAd = () => {
      try {
        (window.adsbygoogle = window.adsbygoogle || []).push({});
      } catch {}
    };
    if (adsScript.dataset.loaded === 'true') pushAd();
    else adsScript.addEventListener('load', pushAd, { once: true });
  }

})();
