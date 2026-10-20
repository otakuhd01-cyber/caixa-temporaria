import 'dart:async';
import 'dart:convert';
import 'dart:math';
import 'package:http/http.dart' as http;

/// Modelo simples para representar mensagens recebidas
class MailMessage {
  final String id;
  final String subject;
  final String sender;
  final String textBody;
  final DateTime? createdAt;

  MailMessage({
    required this.id,
    required this.subject,
    required this.sender,
    required this.textBody,
    this.createdAt,
  });
}

class MailGwService {
  static const String _apiBase = 'api.mail.gw';
  
  String? token;
  String? accountId;
  String? address;
  bool busy = false;

  /// Método utilitário centralizado para requisições HTTP na API Mail.gw
  Future<dynamic> _api(
    String path, {
    String method = 'GET',
    Map<String, dynamic>? body,
    bool auth = true,
  }) async {
    if (!path.startsWith('/')) {
      throw Exception('Destino de rede não permitido.');
    }

    final url = Uri.https(_apiBase, path);
    final headers = <String, String>{
      'Accept': 'application/json',
    };

    if (body != null) {
      headers['Content-Type'] = 'application/json';
    }

    if (token != null && auth) {
      headers['Authorization'] = 'Bearer $token';
    }

    http.Response response;
    try {
      final request = http.Request(method, url)..headers.addAll(headers);
      if (body != null) {
        request.body = jsonEncode(body);
      }

      final streamedResponse = await request.send().timeout(
        const Duration(seconds: 15),
      );
      response = await http.Response.fromStream(streamedResponse);
    } on TimeoutException {
      throw Exception('A solicitação excedeu 15 segundos e foi cancelada.');
    } catch (_) {
      throw Exception('Não foi possível conectar diretamente à API Mail.gw. Verifique sua conexão.');
    }

    // Validação de tamanho máximo da resposta (2MB)
    if (response.bodyBytes.length > 2 * 1024 * 1024) {
      throw Exception('Resposta muito grande; solicitação interrompida por segurança.');
    }

    dynamic data;
    if (response.body.isNotEmpty) {
      try {
        data = jsonDecode(response.body);
      } catch (_) {
        throw Exception('O serviço retornou uma resposta inesperada.');
      }
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      final safeMessages = <int, String>{
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

      throw Exception(
        safeMessages[response.statusCode] ?? 'Falha no serviço de e-mail (HTTP ${response.statusCode}).',
      );
    }

    return data;
  }

  /// Gera senha segura em formato hexadecimal (semelhante ao crypto.getRandomValues)
  String _randomPassword() {
    final random = Random.secure();
    final values = List<int>.generate(24, (_) => random.nextInt(256));
    return values.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
  }

  /// Cria uma nova caixa postal temporária
  Future<String> createMailbox() async {
    if (busy) throw Exception('Uma operação já está em andamento.');
    busy = true;

    try {
      // 1. Obtém lista de domínios ativos
      List<String> domains = [];
      try {
        final domainData = await _api('/domains?page=1', auth: false);
        if (domainData != null && domainData['hydra:member'] is List) {
          final members = domainData['hydra:member'] as List;
          domains = members
              .where((d) =>
                  d != null &&
                  d['domain'] is String &&
                  d['isActive'] != false &&
                  d['isPrivate'] != true)
              .map((d) => (d['domain'] as String).toLowerCase())
              .toList();
        }
      } catch (err) {
        // Ignora erro inicial de domínio se necessário
      }

      if (domains.isEmpty) {
        throw Exception('O Mail.gw não retornou domínios disponíveis. Tente novamente mais tarde.');
      }

      final password = _randomPassword();
      Map<String, dynamic>? account;
      String? generatedAddress;
      Exception? lastCreateError;

      // 2. Tenta criar conta com nomes aleatórios (até 6 tentativas)
      final random = Random.secure();
      for (var attempt = 0; attempt < 6; attempt++) {
        final domain = domains[random.nextInt(domains.length)];
        final randomBytes = List<int>.generate(7, (_) => random.nextInt(256));
        final randomPart = randomBytes.map((b) => b.toRadixString(16).padLeft(2, '0')).join();
        
        generatedAddress = 'temp$randomPart@$domain';

        try {
          final res = await _api(
            '/accounts',
            method: 'POST',
            auth: false,
            body: {'address': generatedAddress, 'password': password},
          );
          account = res as Map<String, dynamic>;
          break;
        } on Exception catch (err) {
          lastCreateError = err;
          if (!err.toString().contains('409') &&
              !err.toString().contains('422') &&
              !err.toString().contains('já existe')) {
            rethrow;
          }
        }
      }

      if (account == null || generatedAddress == null) {
        throw Exception(
          'O serviço recusou os endereços gerados. ${lastCreateError?.toString() ?? ''}',
        );
      }

      // 3. Autentica e obtém o token JWT
      final tokenData = await _api(
        '/token',
        method: 'POST',
        auth: false,
        body: {'address': generatedAddress, 'password': password},
      );

      if (tokenData['token'] == null || account['id'] == null) {
        throw Exception('O serviço forneceu dados incompletos.');
      }

      token = tokenData['token'] as String;
      accountId = account['id'] as String;
      address = generatedAddress;

      return address!;
    } finally {
      busy = false;
    }
  }

  /// Busca e detalha as mensagens da caixa criada (processamento paralelo)
  Future<List<MailMessage>> refreshMessages() async {
    if (token == null) throw Exception('Nenhuma conta ativa para consultar mensagens.');
    if (busy) return [];
    busy = true;

    try {
      final data = await _api('/messages?page=1');
      final rawMessages = (data != null && data['hydra:member'] is List)
          ? data['hydra:member'] as List
          : [];

      if (rawMessages.isEmpty) {
        return [];
      }

      // Busca os detalhes das 10 mensagens mais recentes em paralelo (equivalente ao Promise.all)
      final topMessages = rawMessages.take(10).toList();
      final detailsFutures = topMessages.map((msg) async {
        if (msg == null || msg['id'] == null) return null;
        try {
          final String msgId = Uri.encodeComponent(msg['id'].toString());
          return await _api('/messages/$msgId');
        } catch (_) {
          return msg;
        }
      });

      final details = await Future.wait(detailsFutures);
      final List<MailMessage> parsedMessages = [];

      for (final detail in details) {
        if (detail == null) continue;

        String textBody = '';
        if (detail['text'] is List) {
          textBody = (detail['text'] as List).join('\n');
        } else if (detail['text'] is String) {
          textBody = detail['text'];
        }

        String sender = 'Remetente não informado';
        if (detail['from'] != null) {
          final fromObj = detail['from'];
          final name = fromObj['name'] ?? '';
          final addr = fromObj['address'] != null ? '<${fromObj['address']}>' : '';
          sender = '$name $addr'.trim();
        }

        DateTime? createdAt;
        if (detail['createdAt'] != null) {
          createdAt = DateTime.tryParse(detail['createdAt'].toString());
        }

        parsedMessages.add(
          MailMessage(
            id: detail['id'].toString(),
            subject: detail['subject']?.toString() ?? '(Sem assunto)',
            sender: sender,
            textBody: textBody.isNotEmpty
                ? textBody
                : 'Esta mensagem não contém texto simples. O conteúdo HTML foi ocultado por segurança.',
            createdAt: createdAt,
          ),
        );
      }

      return parsedMessages;
    } finally {
      busy = false;
    }
  }

  /// Exclui a conta criada no serviço externo
  Future<void> deleteMailbox() async {
    if (token == null || accountId == null) return;
    if (busy) return;
    busy = true;

    try {
      final String id = Uri.encodeComponent(accountId!);
      await _api('/accounts/$id', method: 'DELETE');
    } finally {
      token = null;
      accountId = null;
      address = null;
      busy = false;
    }
  }
}
