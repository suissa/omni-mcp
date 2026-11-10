# 1. Inicializa o Sintetizador de Voz nativo do Windows (TTS)
Add-Type -AssemblyName System.Speech
$Sintetizador = New-Object System.Speech.Synthesis.SpeechSynthesizer

Clear-Host
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "🎙️  CONFIGURAÇÃO DE VOZ DO ASSISTENTE" -ForegroundColor Cyan
Write-Host "====================================================`n" -ForegroundColor Cyan

# 2. Busca e filtra as vozes em Português
$VozesPtBr = $Sintetizador.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -eq "pt-BR" }

if (-not $VozesPtBr) {
    Write-Host "⚠️ Nenhuma voz pt-BR dedicada foi encontrada. Usando o padrão do sistema." -ForegroundColor Yellow
    Start-Sleep -Seconds 2
} else {
    Write-Host "Escolha uma das vozes em português instaladas no seu Windows:`n" -ForegroundColor White
    for ($i = 0; $i -lt $VozesPtBr.Count; $i++) {
        $info = $VozesPtBr[$i].VoiceInfo
        Write-Host " [$i] - $($info.Name) ($($info.Gender))" -ForegroundColor Cyan
    }
    
    Write-Host ""
    $Escolha = Read-Host "Digite o número da voz desejada"
    
    # Valida a escolha do usuário
    if ($Escolha -match '^\d+$' -and [int]$Escolha -lt $VozesPtBr.Count) {
        $NomeVozSelecionada = $VozesPtBr[[int]$Escolha].VoiceInfo.Name
        $Sintetizador.SelectVoice($NomeVozSelecionada)
        Write-Host "✅ Voz selecionada: $NomeVozSelecionada`n" -ForegroundColor Green
    } else {
        Write-Host "⚠️ Seleção inválida. Usando a primeira voz pt-BR por padrão.`n" -ForegroundColor Yellow
        $Sintetizador.SelectVoice($VozesPtBr[0].VoiceInfo.Name)
    }
    Start-Sleep -Seconds 1
}

# 3. Configurações Globais do Assistente
$Modelo = "lfm3-omni:2b"
$PromptBase = "Responda à pergunta ou comando feito neste áudio de forma direta, natural e concisa em português:"
$CaminhoAudio = "$env:TEMP\gravacao_loop_ollama.wav"

# Injeta a API de som nativa do Windows para gravação via DLL
$MciCode = @"
using System;
using System.Runtime.InteropServices;
public class Microfone {
    [DllImport("winmm.dll", EntryPoint = "mciSendStringA", CharSet = CharSet.Ansi)]
    public static extern int SendString(string command, string buffer, int bufferSize, IntPtr hwndCallback);
}
"@
Add-Type -TypeDefinition $MciCode -ErrorAction SilentlyContinue

Clear-Host
Write-Host "====================================================" -ForegroundColor Cyan
Write-Host "🔊 ASSISTENTE DE VOZ LOCAL EM PORTUGUÊS ($Modelo)" -ForegroundColor Cyan
Write-Host "   Pronto! O assistente vai ouvir você e responder." -ForegroundColor Green
Write-Host "   Para encerrar, feche a janela ou use Ctrl+C" -ForegroundColor DarkGray
Write-Host "====================================================`n" -ForegroundColor Cyan

# Loop infinito de conversação
while ($true) {
    if (Test-Path $CaminhoAudio) { Remove-Item $CaminhoAudio }

    Write-Host "🎙️  [OUVINDO] Fale agora..." -ForegroundColor Yellow
    Write-Host "👉  Pressione [ENTER] quando terminar de falar..." -ForegroundColor Gray

    # Inicia a captura do microfone
    [Microfone]::SendString("open new type waveaudio alias gravador", $null, 0, [IntPtr]::Zero)
    [Microfone]::SendString("record gravador", $null, 0, [IntPtr]::Zero)

    # Aguarda o usuário concluir a fala pressionando Enter
    $null = Read-Host

    # Para e salva a gravação no arquivo temporário
    Write-Host "🛑 Gravado! Processando áudio..." -ForegroundColor DarkYellow
    [Microfone]::SendString("save gravador $CaminhoAudio", $null, 0, [IntPtr]::Zero)
    [Microfone]::SendString("close gravador", $null, 0, [IntPtr]::Zero)

    Start-Sleep -Milliseconds 800

    if ((Test-Path $CaminhoAudio) -and ((Get-Item $CaminhoAudio).Length -gt 2000)) {
        
        Write-Host "🔄 Convertendo áudio e enviando para o Ollama..." -ForegroundColor Cyan
        try {
            $audioBase64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($CaminhoAudio))

            $CorpoRequest = @{
                model = $Modelo
                messages = @(
                    @{
                        role = "user"
                        content = $PromptBase
                        audios = @($audioBase64)
                    }
                )
                stream = $false
            } | ConvertTo-Json -Depth 10

            $Resposta = Invoke-RestMethod -Uri "http://localhost:11434/api/chat" -Method POST -ContentType "application/json" -Body $CorpoRequest
            $TextoResposta = $Resposta.message.content

            # Exibe a resposta do modelo na tela
            Write-Host "`n🤖 RESPOSTA:" -ForegroundColor Green
            Write-Host $TextoResposta -ForegroundColor White
            Write-Host "----------------------------------------------------" -ForegroundColor Cyan

            # Fala a resposta em voz alta com a voz configurada
            Write-Host "🗣️  Falando..." -ForegroundColor DarkCyan
            $Sintetizador.Speak($TextoResposta)
            Write-Host "`n"

        } catch {
            Write-Host "❌ Erro ao processar dados ou conectar com o Ollama local.`n" -ForegroundColor Red
        }

    } else {
        Write-Host "⚠️ Nenhum som detectado ou áudio muito curto. Vamos tentar de novo...`n" -ForegroundColor Yellow
    }

    if (Test-Path $CaminhoAudio) { Remove-Item $CaminhoAudio }
    Start-Sleep -Seconds 1
}
