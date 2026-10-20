'use strict';

(() => {
  // A documentação do Mail.gw informa suporte a CORS. Chamamos a API diretamente.
  const FILE_MODE = window.location.protocol === 'file:';
  const API = 'https://api.mail.gw';
  const $ = (id) => document.getElementById(id);
  const state = { token: null, accountId: null, address: null, busy: false, messageIds: new Set(), lastRequestAt: 0 };

  const setStatus = (message) => { 
    const el = $('status');
    if (el) el.textContent = message; 
  };

  const setBusy = (busy) => {
    state.busy = busy;
    ['createBtn', 'refreshBtn', 'deleteBtn', 'copyBtn'].forEach((id) => {
      const el = $(id);
      if (el) el.disabled = busy || (id !== 'createBtn' && !state.token);
    });
  };

  async function api(path, options = {}) {
    if (typeof path !== 'string' || !path.startsWith('/')) throw new Error('Destino de rede não permitido.');
    
    // Mantém o caminho correto mantendo os recursos da API Mail.gw
    const url = new URL(path, API);
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
      throw new Error('Não foi possível conectar diretamente à API Mail.gw. Verifique sua conexão.');
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
        422: 'O serviço não aceitou esse endereço (ele pode já existir ou o domínio pode estar indisponível).',
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
    const msgEl = $('messages');
    if (msgEl) msgEl.replaceChildren();
    const countEl = $('count');
    if (countEl) countEl.textContent = '0';
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
    const msgContainer = $('messages');
    if (msgContainer) msgContainer.append(card);
  }

  async function createMailbox() {
    if (state.busy) return;
    let created = false;
    setBusy(true);
    setStatus('Consultando domínios disponíveis…');
    
    try {
      let domains = [];
      try {
        const domainData = await api('/domains?page=1', { auth: false });
        domains = Array.isArray(domainData['hydra:member']) ? domainData['hydra:member'] : [];
        domains = domains
          .filter(d => d && typeof d.domain === 'string' && d.domain && d.isActive !== false && d.isPrivate !== true)
          .map(d => d.domain.toLowerCase());
      } catch (err) {
        console.warn('Não foi possível consultar a lista de domínios:', err);
      }

      if (!domains.length) throw new Error('O Mail.gw não retornou domínios disponíveis. Tente novamente mais tarde.');
      
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
          account = await api('/accounts', {
            method: 'POST',
            auth: false,
            body: { address, password }
          });
          break;
        } catch (err) {
          lastCreateError = err;
          if (!(err instanceof Error) || !/HTTP 409|HTTP 422|já existe|não aceitou/i.test(err.message)) {
            throw err;
          }
        }
      }

      if (!account) {
        throw new Error(
          'O serviço recusou os endereços gerados.' + (lastCreateError ? ` (${lastCreateError.message})` : '')
        );
      }

      const tokenData = await api('/token', {
        method: 'POST',
        auth: false,
        body: { address, password }
      });

      if (!tokenData.token || !account.id) {
        throw new Error('O serviço forneceu dados incompletos.');
      }
      
      state.token = tokenData.token;
      state.accountId = account.id;
      state.address = address;

      if ($('emailAddress')) {$('emailAddress').value = address;
        $('emailAddress').readOnly = true;
      }
      if ($('mailboxArea'))$('mailboxArea').hidden = false;
      
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
      const data = await api('/messages?page=1');
      const messages = Array.isArray(data['hydra:member']) ? data['hydra:member'] : [];
      clearMessages();
      
      if ($('count'))$('count').textContent = String(messages.length);
      
      if (!messages.length) {
        const p = document.createElement('p');
        p.className = 'muted';
        p.textContent = 'Nenhuma mensagem recebida ainda.';
        if ($('messages'))$('messages').append(p);
      } else {
        // Busca os detalhes das 10 mensagens mais recentes em paralelo para otimizar velocidade
        const details = await Promise.all(
          messages.slice(0, 10).map(async (msg) => {
            if (!msg || !msg.id) return null;
            try { return await api(`/messages/${encodeURIComponent(String(msg.id))}`); }
            catch { return msg; }
          })
        );

        for (const detail of details) {
          if (!detail) continue;
          const textBody = Array.isArray(detail.text) ? detail.text.join('\n') : (typeof detail.text === 'string' ? detail.text : '');
          addTextMessage(detail, textBody);
        }
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
      await api(`/accounts/${encodeURIComponent(String(state.accountId))}`, { method: 'DELETE' });
      setStatus('Solicitação de exclusão enviada ao serviço.');
    } catch (error) {
      setStatus(`Não foi possível confirmar a exclusão no serviço. ${error instanceof Error ? error.message : ''}`.trim());
    } finally {
      state.token = null;
      state.accountId = null;
      state.address = null;
      
      if ($('emailAddress'))$('emailAddress').value = '';
      if ($('mailboxArea'))$('mailboxArea').hidden = true;
      
      clearMessages();
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'Caixa desconectada.';
      if ($('messages'))$('messages').append(p);
      
      setBusy(false);
    }
  }

  // Event Listeners
  const createBtn = $('createBtn');
  if (createBtn) createBtn.addEventListener('click', createMailbox);

  const refreshBtn = $('refreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', refreshMessages);

  const deleteBtn = $('deleteBtn');
  if (deleteBtn) deleteBtn.addEventListener('click', deleteMailbox);

  const copyBtn = $('copyBtn');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      if (!state.address) return;
      try {
        await navigator.clipboard.writeText(state.address);
        setStatus('Endereço copiado.');
      } catch {
        if ($('emailAddress'))$('emailAddress').select();
        setStatus('Não foi possível copiar automaticamente. Selecione e copie manualmente.');
      }
    });
  }

  window.addEventListener('pagehide', () => {
    state.token = null;
    state.accountId = null;
  });

  setBusy(false);
  if (FILE_MODE) {
    setStatus('Modo local (file://) detectado. Se houver problemas de CORS, execute via servidor HTTP.');
  }

  // AdSense
  const adsScript = document.querySelector('script[src*="pagead/js/adsbygoogle.js"]');
  const adSlot = document.querySelector('ins.adsbygoogle');
  if (adsScript && adSlot) {
    const pushAd = () => {
      try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } 
      catch {}
    };
    if (adsScript.dataset.loaded === 'true') pushAd();
    else adsScript.addEventListener('load', pushAd, { once: true });
  }
})();

