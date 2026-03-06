import React, { useState, useMemo, useCallback, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { 
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  PieChart, Pie, Cell, LabelList
} from 'recharts';
import { FileUp, FileText, Download, PieChart as PieIcon, BarChart3, Info, AlertCircle, CheckCircle2, Loader2, MapPin } from 'lucide-react';
import { GoogleGenAI } from "@google/genai";
import ReactMarkdown from 'react-markdown';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// --- Utils ---
function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// --- Types ---
interface DataRow {
  [key: string]: any;
}

interface AnalysisResult {
  total: number;
  totalEnRegion: number;
  conMesa: number;
  sinMesa: number;
  fueraRegion: number;
  noContactado: number;
  totalVotosValidos: number;
  sinRespuestaCount: number;
  uniqueMunicipios: number;
  llamadaStats: { name: string; value: number }[];
  candidateStats: { name: string; value: number }[];
  municipioStats: { name: string; value: number; percentage: number }[];
  aiInsight: string;
  headers: string[];
  detectedColumns: {
    encuesta: string;
    departamento: string;
    municipio: string;
    llamada: string;
    puesto: string;
  };
}

// --- AI Service ---
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || '' });

async function getAIAnalysis(dataSummary: string) {
  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: `Eres un analista de datos experto. Analiza los siguientes resultados de una encuesta telefónica en el departamento del Cesar, Colombia.
      
      DATOS ESTADÍSTICOS:
      ${dataSummary}
      
      TAREA:
      Genera un informe ejecutivo profesional en español que incluya:
      1. Resumen de la efectividad de la campaña de llamadas (porcentajes de éxito vs fallos).
      2. Identificación de hallazgos clave o "evidencias" encontradas en los datos.
      4. Recomendaciones breves basadas en los resultados.
      
      Mantén el informe conciso (máximo 300 palabras) y usa un tono ejecutivo.`,
      config: {
        systemInstruction: "Eres un analista de datos experto. Tu tono es profesional, analítico y constructivo. Escribe en español.",
      }
    });
    return response.text || "No se pudo generar el análisis.";
  } catch (error) {
    console.error("AI Analysis Error:", error);
    return "Error al conectar con el servicio de IA.";
  }
}

// --- Constants ---
const DEFAULT_COLORS = [
  '#4f46e5', '#10b981', '#ef4444', '#f59e0b', '#6366f1', '#8b5cf6', '#ec4899', '#06b6d4', '#f97316', '#6366f1'
];

// --- Main Component ---
export default function App() {
  const [data, setData] = useState<DataRow[]>([]);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reportName, setReportName] = useState("Análisis de Registros y Muestra Estadística");
  const [reportColor, setReportColor] = useState("#4f46e5");
  const [surveyScope, setSurveyScope] = useState<'nacional' | 'regional'>('regional');
  const [targetRegion, setTargetRegion] = useState("Cesar");
  const [candidateColors, setCandidateColors] = useState<Record<string, string>>({});
  const [showConfig, setShowConfig] = useState(true);

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setError(null);

    const reader = new FileReader();
    reader.onload = async (evt) => {
      try {
        const bstr = evt.target?.result;
        const wb = XLSX.read(bstr, { type: 'binary' });
        const wsname = wb.SheetNames[0];
        const ws = wb.Sheets[wsname];
        const jsonData = XLSX.utils.sheet_to_json(ws) as DataRow[];

        if (jsonData.length === 0) {
          throw new Error("El archivo Excel está vacío.");
        }

        setData(jsonData);
        await processData(jsonData);
      } catch (err: any) {
        setError(err.message || "Error al procesar el archivo.");
      } finally {
        setLoading(false);
      }
    };
    reader.readAsBinaryString(file);
  };

  const processData = useCallback(async (rows: DataRow[]) => {
    const headers = Object.keys(rows[0]);
    const cleanHeaders = headers.map(h => ({ original: h, clean: h.trim().toLowerCase() }));

    const normalizeText = (text: string): string => {
      return text
        .trim()
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-z0-9\s]/g, "");
    };

    const findColumn = (possibleKeys: string[], blacklist: string[] = []): string => {
      const isBlacklisted = (name: string) => {
        const lower = name.toLowerCase();
        return blacklist.some(b => lower === b.toLowerCase() || lower.includes(b.toLowerCase() + '_id') || lower.startsWith('id_'));
      };

      // Exact match
      for (const pk of possibleKeys) {
        const pkLower = pk.toLowerCase();
        const found = cleanHeaders.find(ch => ch.clean === pkLower && !isBlacklisted(ch.original));
        if (found) return found.original;
      }
      // Partial match
      for (const pk of possibleKeys) {
        if (pk.length < 4) continue;
        const pkLower = pk.toLowerCase();
        const found = cleanHeaders.find(ch => 
          (ch.clean.includes(pkLower) || pkLower.includes(ch.clean)) && !isBlacklisted(ch.original)
        );
        if (found) return found.original;
      }
      return '';
    };

    const colEncuesta = findColumn([
      'Si las elecciones para la cámara de representante para el cesar fueran este domingo, ¿por cuál de los siguientes candidatos o listas votaría usted?*',
      'Si las elecciones para la cámara de representante para el cesar fueran este domingo, ¿por cuál de los siguientes candidatos o listas votaría usted?',
      'Encuesta gumer - Si las elecciones para la cámara de representante para el cesar fueran este domingo, ¿por cuál de los siguientes candidatos o listas votaría usted?*',
      'Encuesta gumer - Si las elecciones para la cámara de representante para el cesar fueran este domingo, ¿por cuál de los siguientes candidatos o listas votaría usted?',
      '¿por cuál de los siguientes candidatos o listas votaría usted?',
      '¿por cuál de los siguientes candidatos o listas votaría usted?*',
      'Encuesta gumer', 
      'por cuál de los siguientes candidatos', 
      'Encuesta', 
      'Voto', 
      'Candidato', 
      'Intención', 
      'Respuesta', 
      'Votaría', 
      'Votaria', 
      'ENCUEST', 
      'ENCUESTA'
    ], ['ID', 'Nro', 'Consecutivo', 'Index', 'Codigo', 'Celular', 'Telefono', 'Documento', 'Cedula']);
    const colDepto = findColumn(['Departamento', 'Depto', 'Región', 'Dpto', 'Estado', 'Provincia', 'DEPARTAM', 'DPTO', 'DEPART']);
    const colMpio = findColumn(['Municipio (puesto)', 'Municipio', 'Ciudad', 'Pueblo', 'Mpio', 'Municipality', 'Localidad', 'Ubicación', 'Ubicacion', 'Centro Poblado', 'Barrio', 'Vereda', 'MUNIC', 'MUN', 'CIUDAD_MUNICIPIO', 'CIUDAD', 'POBLACION', 'ZONA', 'LUGAR', 'SITIO', 'AREA', 'MUNICIPIO', 'MUNICIPI']);
    const colLlamada = findColumn(['Contactable', 'Contactabilidad', 'Llamada', 'Estado', 'Resultado', 'Estatus', 'Contacto', 'LLAMAD', 'LLAMADA', 'CONTACTABILID']);
    const colPuesto = findColumn(['lugar_votación', 'lugar_votacion', 'Puesto', 'Mesa', 'Lugar', 'Votación', 'Votacion', 'Puesto_Votacion', 'PUESTO'], ['Municipio', 'Mpio', 'City', 'Municipio (puesto)']);

    let conMesa = 0;
    let sinMesa = 0;
    let fueraRegion = 0;
    let noContactado = 0;
    let totalEnRegion = 0;

    const llamadaCounts: Record<string, number> = {
      'Contestada': 0,
      'No contestaron / Buzón': 0,
      'Numero Errado': 0,
      'Otros': 0
    };

    const candidateCounts: Record<string, number> = {};
    const municipioCounts: Record<string, number> = {};
    const uniqueMunicipiosSet = new Set<string>();

    // Maps to store canonical names for normalized versions
    const canonicalCandidates = new Map<string, string>();
    const canonicalMunicipios = new Map<string, string>();

    rows.forEach(row => {
      const encuestaValRaw = colEncuesta ? String(row[colEncuesta] || '').trim() : '';
      const departamentoVal = colDepto ? String(row[colDepto] || '').trim() : '';
      const municipioValRaw = colMpio ? String(row[colMpio] || '').trim() : '';
      const llamadaVal = colLlamada ? String(row[colLlamada] || '').trim() : '';
      const puestoVal = colPuesto ? String(row[colPuesto] || '').trim() : '';

      // Puesto/Mesa Logic
      const pValLower = puestoVal.toLowerCase();
      // If the column has info and it's not '-', 'ninguno', 'ninguna', or empty -> Con Mesa
      if (puestoVal !== '' && puestoVal !== '-' && pValLower !== 'ninguno' && pValLower !== 'ninguna' && pValLower !== 'n/a' && pValLower !== 'sin puesto' && pValLower !== 'sin mesa') {
        conMesa++;
      } else {
        sinMesa++;
      }

      // Scope filtering
      let isWithinRegion = true;
      if (surveyScope === 'regional') {
        const dValLower = departamentoVal.toLowerCase();
        const targetLower = targetRegion.trim().toLowerCase();
        
        // If we found a departamento value, check it. 
        // If we didn't find a departamento column/value, we'll assume it's within region 
        // to avoid filtering out everything if the column is missing.
        if (departamentoVal !== '' && !dValLower.includes(targetLower)) {
          fueraRegion++;
          isWithinRegion = false;
        }
      }

      if (isWithinRegion) {
        totalEnRegion++;
      }

      // Candidate / Vote Logic
      const eValLower = encuestaValRaw.toLowerCase();
      let encuestaVal = encuestaValRaw;

      if (encuestaValRaw === '-' || eValLower === 'no contactado') {
        noContactado++;
        candidateCounts['No contactado'] = (candidateCounts['No contactado'] || 0) + 1;
      } else if (encuestaValRaw === '' || eValLower === 'sin respuesta' || eValLower === '(sin respuesta)') {
        // Empty fields mean "(Sin respuesta)"
        candidateCounts['(Sin respuesta)'] = (candidateCounts['(Sin respuesta)'] || 0) + 1;
      } else if (!eValLower.includes('con puesto') && 
                 !eValLower.includes('sin puesto') && 
                 eValLower !== 'si' && 
                 eValLower !== 'sí' && 
                 eValLower !== 'no') {
        const normalized = normalizeText(encuestaValRaw);
        if (!canonicalCandidates.has(normalized)) {
          canonicalCandidates.set(normalized, encuestaValRaw);
        }
        encuestaVal = canonicalCandidates.get(normalized)!;
        candidateCounts[encuestaVal] = (candidateCounts[encuestaVal] || 0) + 1;
      } else {
        // If it's something else like "Si/No" but in the candidate column, count it as other/invalid for now
        candidateCounts['Otros/Inválidos'] = (candidateCounts['Otros/Inválidos'] || 0) + 1;
      }

      // Municipality Logic (only for records within region if regional)
      if (isWithinRegion) {
        if (municipioValRaw !== '' && municipioValRaw !== '-') {
          const normalized = normalizeText(municipioValRaw);
          if (!canonicalMunicipios.has(normalized)) {
            canonicalMunicipios.set(normalized, municipioValRaw);
          }
          const municipioVal = canonicalMunicipios.get(normalized)!;
          municipioCounts[municipioVal] = (municipioCounts[municipioVal] || 0) + 1;
          uniqueMunicipiosSet.add(municipioVal.toLowerCase());
        }
      }

      // Logic for Llamada
      const lVal = llamadaVal.toLowerCase();
      if (lVal.includes('contestada') || lVal === 'si' || lVal === 'sí' || lVal.includes('efectiva')) {
        llamadaCounts['Contestada']++;
      } else if (lVal === 'no' || lVal === '-' || lVal.includes('buzon') || lVal.includes('buzón') || lVal.includes('mensajes') || lVal.includes('no contestaron')) {
        llamadaCounts['No contestaron / Buzón']++;
      } else if (lVal.includes('errado') || lVal.includes('no efectiva')) {
        llamadaCounts['Numero Errado']++;
      } else {
        llamadaCounts['Otros']++;
      }
    });

    const allCandidateStats = Object.entries(candidateCounts)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => {
        // Keep "No contactado" and "(Sin respuesta)" at the bottom
        if (a.name === 'No contactado' || a.name === '(Sin respuesta)') return 1;
        if (b.name === 'No contactado' || b.name === '(Sin respuesta)') return -1;
        return b.value - a.value;
      });

    // We'll show all candidates in the chart now to reflect the total records
    const candidateStats = allCandidateStats;
    const totalVotosValidos = candidateStats
      .filter(c => c.name !== 'No contactado' && c.name !== '(Sin respuesta)' && c.name !== 'Otros/Inválidos')
      .reduce((sum, c) => sum + c.value, 0);

    const municipioStats = Object.entries(municipioCounts)
      .map(([name, value]) => ({ 
        name, 
        value, 
        percentage: totalEnRegion > 0 ? (value / totalEnRegion) * 100 : 0
      }))
      .sort((a, b) => b.value - a.value);

    const summary = `Total registros: ${rows.length}. 
    Alcance: ${surveyScope === 'regional' ? `Regional (${targetRegion}) - Total en región: ${totalEnRegion}` : 'Nacional'}.
    Intención de Voto: ${candidateStats.map(c => `${c.name}: ${c.value}`).join(', ')}.
    No contactados (-): ${noContactado}.
    Fuera de la región objetivo: ${fueraRegion}.
    Distribución por Municipios: ${municipioStats.slice(0, 5).map(m => `${m.name}: ${m.percentage.toFixed(1)}%`).join(', ')}.
    Mesa/Puesto: Con mesa: ${conMesa} (${((conMesa / rows.length) * 100).toFixed(1)}%), Sin mesa: ${sinMesa} (${((sinMesa / rows.length) * 100).toFixed(1)}%).
    Estado de Llamadas: Contestadas: ${llamadaCounts['Contestada']}, No contestaron: ${llamadaCounts['No contestaron / Buzón']}, Numero Errado: ${llamadaCounts['Numero Errado']}, Otros: ${llamadaCounts['Otros']}.`;
    
    const aiInsight = await getAIAnalysis(summary);

    setAnalysis({
      total: rows.length,
      totalEnRegion,
      conMesa,
      sinMesa,
      fueraRegion,
      noContactado,
      totalVotosValidos,
      sinRespuestaCount: allCandidateStats.find(c => c.name === '(Sin respuesta)')?.value || 0,
      uniqueMunicipios: uniqueMunicipiosSet.size,
      llamadaStats: Object.entries(llamadaCounts)
        .map(([name, value]) => ({ name, value }))
        .filter(item => item.value > 0),
      candidateStats,
      municipioStats,
      aiInsight,
      headers,
      detectedColumns: {
        encuesta: colEncuesta,
        departamento: colDepto,
        municipio: colMpio,
        llamada: colLlamada,
        puesto: colPuesto
      }
    });
    setShowConfig(false);
  }, [surveyScope, targetRegion]);

  // Dedicated effect to initialize candidate colors when stats change
  useEffect(() => {
    if (!analysis?.candidateStats) return;

    setCandidateColors(prev => {
      const newColors = { ...prev };
      const defaultPalette = ['#4f46e5', '#10b981', '#ef4444', '#f59e0b', '#6366f1', '#8b5cf6', '#ec4899'];
      
      if (!newColors['(Sin respuesta)']) newColors['(Sin respuesta)'] = '#94a3b8';
      if (!newColors['No contactado']) newColors['No contactado'] = '#cbd5e1';
      if (!newColors['Otros/Inválidos']) newColors['Otros/Inválidos'] = '#e2e8f0';

      analysis.candidateStats.forEach((c, i) => {
        if (!newColors[c.name]) {
          newColors[c.name] = defaultPalette[i % defaultPalette.length];
        }
      });
      
      // Only return new object if something actually changed to avoid infinite loops
      const hasChanged = Object.keys(newColors).length !== Object.keys(prev).length ||
        Object.keys(newColors).some(key => newColors[key] !== prev[key]);
        
      return hasChanged ? newColors : prev;
    });
  }, [analysis?.candidateStats]);

  const generatePDF = async () => {
    if (!analysis) return;

    const element = document.getElementById('report-content');
    if (!element) {
      setError("No se pudo encontrar el contenido del reporte.");
      return;
    }

    setPdfLoading(true);
    setError(null);

    try {
      // Ensure we are at the top for capture
      window.scrollTo(0, 0);

      const canvas = await html2canvas(element, { 
        scale: 2, 
        useCORS: true,
        logging: false,
        allowTaint: true,
        backgroundColor: '#ffffff',
        windowWidth: 1000, // Fixed width for consistent aspect ratio
        onclone: (clonedDoc) => {
          const report = clonedDoc.getElementById('report-content');
          if (report) {
            // Force the report to be exactly 1000px wide for the capture
            report.style.width = '1000px';
            report.style.maxWidth = '1000px';
            report.style.margin = '0';
            report.style.padding = '40px';
            report.style.borderRadius = '0';
            report.style.boxShadow = 'none';
            report.style.border = 'none';
            
            // Ensure parent containers don't add margins or restrict width
            let parent = report.parentElement;
            while (parent) {
              parent.style.width = '1000px';
              parent.style.maxWidth = '1000px';
              parent.style.margin = '0';
              parent.style.padding = '0';
              parent = parent.parentElement;
            }

            // Force standard fonts and colors for all elements
            const allElements = report.getElementsByTagName('*');
            for (let i = 0; i < allElements.length; i++) {
              const el = allElements[i] as HTMLElement;
              el.style.setProperty('--tw-ring-color', '#cbd5e1');
              el.style.setProperty('--tw-shadow-color', 'rgba(0,0,0,0.1)');
              // Ensure text is visible and charts have space
              if (el.tagName === 'SVG') {
                el.setAttribute('width', '100%');
              }
            }
          }
        }
      });

      const imgData = canvas.toDataURL('image/jpeg', 0.98);
      const doc = new jsPDF('p', 'mm', 'a4');
      
      const pdfWidth = doc.internal.pageSize.getWidth();
      const pdfHeight = doc.internal.pageSize.getHeight();
      
      // Calculate dimensions to fill the PDF width perfectly
      const imgWidth = pdfWidth;
      const imgHeight = (canvas.height * pdfWidth) / canvas.width;
      
      let heightLeft = imgHeight;
      let position = 0;

      // Add the first page
      doc.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight, undefined, 'FAST');
      heightLeft -= pdfHeight;

      // Add subsequent pages if the content is longer than one page
      while (heightLeft > 0) {
        position = heightLeft - imgHeight;
        doc.addPage();
        doc.addImage(imgData, 'JPEG', 0, position, imgWidth, imgHeight, undefined, 'FAST');
        heightLeft -= pdfHeight;
      }

      doc.save(`${reportName.replace(/\s+/g, '_')}.pdf`);
    } catch (err: any) {
      console.error("PDF Generation Error:", err);
      setError("Error al generar el PDF. Por favor, intenta de nuevo.");
    } finally {
      setPdfLoading(false);
    }
  };

    const COLORS = useMemo(() => [
      reportColor, 
      '#10b981', // Emerald
      '#3b82f6', // Blue
      '#f59e0b', // Amber
      '#ef4444', // Red
      '#8b5cf6', // Violet
      '#ec4899', // Pink
      '#06b6d4', // Cyan
      '#f97316', // Orange
      '#6366f1', // Indigo
    ], [reportColor]);

  return (
    <div className="min-h-screen bg-[#F8FAFC] text-slate-900 font-sans p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        {/* Header */}
        <header className="mb-8 flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight text-slate-900">Reporteador Estadístico</h1>
            <p className="text-slate-500 mt-1">Análisis inteligente de datos y generación de informes PDF.</p>
          </div>
          
          <div className="flex items-center gap-3">
            <label 
              className={cn(
                "flex items-center gap-2 px-4 py-2 text-white rounded-lg cursor-pointer transition-all shadow-sm font-medium",
                loading && "opacity-50 cursor-not-allowed"
              )}
              style={{ backgroundColor: reportColor }}
            >
              <FileUp size={18} />
              {loading ? "Procesando..." : "Subir Excel"}
              <input type="file" accept=".xlsx, .xls" className="hidden" onChange={handleFileUpload} disabled={loading} />
            </label>
            
            {analysis && (
              <button 
                onClick={() => setShowConfig(!showConfig)}
                className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-50 transition-all shadow-sm font-medium"
              >
                <Info size={18} />
                {showConfig ? "Ocultar Configuración" : "Mostrar Configuración"}
              </button>
            )}
            
            {analysis && (
              <button 
                onClick={generatePDF}
                disabled={pdfLoading}
                className="flex items-center gap-2 px-4 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-50 transition-all shadow-sm font-medium disabled:opacity-50"
              >
                {pdfLoading ? <Loader2 size={18} className="animate-spin" /> : <Download size={18} />}
                {pdfLoading ? "Generando..." : "Descargar PDF"}
              </button>
            )}
          </div>
        </header>

        {error && (
          <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-xl flex items-start gap-3 text-red-700">
            <AlertCircle className="shrink-0 mt-0.5" size={20} />
            <p>{error}</p>
          </div>
        )}

        {!analysis && !loading && (
          <div className="mt-20 flex flex-col items-center justify-center text-center p-12 border-2 border-dashed border-slate-200 rounded-3xl bg-white/50">
            <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4" style={{ backgroundColor: `${reportColor}10`, color: reportColor }}>
              <FileText size={32} />
            </div>
            <h2 className="text-xl font-semibold mb-2">Comienza subiendo tu archivo</h2>
            <p className="text-slate-500 max-w-sm">
              Sube un archivo Excel (.xlsx) con los datos de tu encuesta para generar un análisis automático y visual.
            </p>
          </div>
        )}

        {loading && !analysis && (
          <div className="mt-20 flex flex-col items-center justify-center text-center">
            <Loader2 className="animate-spin mb-4" size={48} style={{ color: reportColor }} />
            <p className="text-slate-600 font-medium">Analizando datos con IA...</p>
          </div>
        )}

        {analysis && showConfig && (
          <div className="mb-8 space-y-6 animate-in fade-in slide-in-from-top-4 duration-300">
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100 flex flex-col md:grid md:grid-cols-3 gap-6 items-end">
              <div className="space-y-2 w-full">
                <label className="text-sm font-semibold text-slate-700">Nombre del Informe</label>
                <input 
                  type="text" 
                  value={reportName}
                  onChange={(e) => setReportName(e.target.value)}
                  className="w-full px-4 py-2 rounded-lg border border-slate-200 outline-none transition-all"
                  style={{ 
                    borderColor: reportColor + '40',
                    boxShadow: `0 0 0 2px ${reportColor}10`
                  }}
                  placeholder="Ej: Reporte Mensual Cesar"
                />
              </div>
              <div className="space-y-2 w-full">
                <label className="text-sm font-semibold text-slate-700">Alcance de la Encuesta</label>
                <div className="flex bg-slate-100 p-1 rounded-lg">
                  <button 
                    onClick={() => setSurveyScope('nacional')}
                    className={cn(
                      "flex-1 py-1.5 text-xs font-medium rounded-md transition-all",
                      surveyScope === 'nacional' ? "bg-white shadow-sm text-slate-900" : "text-slate-500 hover:text-slate-700"
                    )}
                  >
                    Nacional
                  </button>
                  <button 
                    onClick={() => setSurveyScope('regional')}
                    className={cn(
                      "flex-1 py-1.5 text-xs font-medium rounded-md transition-all",
                      surveyScope === 'regional' ? "bg-white shadow-sm text-slate-900" : "text-slate-500 hover:text-slate-700"
                    )}
                  >
                    Regional
                  </button>
                </div>
              </div>
              {surveyScope === 'regional' && (
                <div className="space-y-2 w-full">
                  <label className="text-sm font-semibold text-slate-700">Departamento Objetivo</label>
                  <input 
                    type="text" 
                    value={targetRegion}
                    onChange={(e) => setTargetRegion(e.target.value)}
                    className="w-full px-4 py-2 rounded-lg border border-slate-200 outline-none transition-all"
                    style={{ 
                      borderColor: reportColor + '40',
                      boxShadow: `0 0 0 2px ${reportColor}10`
                    }}
                    placeholder="Ej: Cesar"
                  />
                </div>
              )}
              <div className="space-y-2 w-full">
                <label className="text-sm font-semibold text-slate-700">Color Representativo</label>
                <div className="flex items-center gap-3 bg-slate-50 p-1 rounded-lg border border-slate-200">
                  <input 
                    type="color" 
                    value={reportColor}
                    onChange={(e) => setReportColor(e.target.value)}
                    className="w-8 h-8 rounded-md cursor-pointer border-0 p-0 bg-transparent overflow-hidden"
                  />
                  <span className="text-xs font-mono text-slate-500 uppercase pr-2">{reportColor}</span>
                </div>
              </div>
            </div>

            {/* Candidate Color Management */}
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
              <h3 className="text-sm font-bold text-slate-800 mb-4 flex items-center gap-2">
                <PieIcon size={16} style={{ color: reportColor }} />
                Colores de Candidatos
              </h3>
              <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-4">
                {analysis.candidateStats.map((c) => (
                  <div key={c.name} className="flex flex-col gap-1">
                    <span className="text-[10px] font-medium text-slate-500 truncate" title={c.name}>{c.name}</span>
                    <div className="flex items-center gap-2 bg-slate-50 p-1 rounded-lg border border-slate-200">
                      <input 
                        type="color" 
                        value={candidateColors[c.name] || reportColor}
                        onChange={(e) => setCandidateColors(prev => ({ ...prev, [c.name]: e.target.value }))}
                        className="w-6 h-6 rounded-md cursor-pointer border-0 p-0 bg-transparent overflow-hidden"
                      />
                      <span className="text-[10px] font-mono text-slate-400 uppercase pr-1">{candidateColors[c.name]}</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {analysis && (
          <div id="report-content" className="space-y-6 bg-white p-6 md:p-10 rounded-3xl shadow-xl border border-slate-100">
            {/* Fix for html2canvas oklch error: Force hex colors for PDF capture */}
            <style dangerouslySetInnerHTML={{ __html: `
              #report-content {
                --tw-ring-color: #cbd5e1 !important;
                --tw-shadow-color: rgba(0,0,0,0.1) !important;
                background-color: #ffffff !important;
                color: #0f172a !important;
              }
              #report-content * {
                border-color: #e2e8f0 !important;
                outline-color: transparent !important;
              }
              .custom-bg { background-color: ${reportColor} !important; }
              .custom-text { color: ${reportColor} !important; }
              .custom-border { border-color: ${reportColor} !important; }
              
              .bg-indigo-600 { background-color: ${reportColor} !important; }
              .text-indigo-600 { color: ${reportColor} !important; }
              .bg-slate-50 { background-color: #f8fafc !important; }
              .bg-slate-100 { background-color: #f1f5f9 !important; }
              .bg-slate-200 { background-color: #e2e8f0 !important; }
              .text-slate-900 { color: #0f172a !important; }
              .text-slate-800 { color: #1e293b !important; }
              .text-slate-700 { color: #334155 !important; }
              .text-slate-600 { color: #475569 !important; }
              .text-slate-500 { color: #64748b !important; }
              .text-slate-400 { color: #94a3b8 !important; }
              .bg-emerald-50 { background-color: #ecfdf5 !important; }
              .text-emerald-700 { color: #047857 !important; }
              .bg-rose-50 { background-color: #fff1f2 !important; }
              .text-rose-700 { color: #be123c !important; }
              .bg-amber-50 { background-color: #fffbeb !important; }
              .text-amber-700 { color: #b45309 !important; }
              .bg-indigo-50 { background-color: #eef2ff !important; }
              .text-indigo-700 { color: #4338ca !important; }
              .bg-indigo-50\\/50 { background-color: rgba(238, 242, 255, 0.5) !important; }
              .border-indigo-100 { border-color: #e0e7ff !important; }
              .border-slate-100 { border-color: #f1f5f9 !important; }
              .border-slate-200 { border-color: #e2e8f0 !important; }
            `}} />
            {/* Report Header */}
            <div className="border-b border-slate-100 pb-6 mb-6">
              <div className="flex items-center gap-2 font-bold uppercase tracking-wider text-xs mb-2" style={{ color: reportColor }}>
                <Info size={14} />
                Informe Generado Automáticamente
              </div>
              <h2 className="text-2xl font-bold text-slate-900">{reportName}</h2>
              <p className="text-slate-500">Basado en {analysis.total} registros procesados.</p>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-4">
              <StatCard label="Total Registros" value={analysis.total} icon={<FileText size={20} />} color="bg-slate-50 text-slate-700" />
              {surveyScope === 'regional' && (
                <StatCard label={`Total en ${targetRegion}`} value={analysis.totalEnRegion} icon={<Info size={20} />} color="bg-indigo-50 text-indigo-700" />
              )}
              <StatCard label="Contestadas" value={analysis.llamadaStats.find(s => s.name === 'Contestada')?.value || 0} icon={<CheckCircle2 size={20} />} color="bg-emerald-50 text-emerald-700" />
              <StatCard label="No Contestaron / Buzón" value={analysis.llamadaStats.find(s => s.name === 'No contestaron / Buzón')?.value || 0} icon={<AlertCircle size={20} />} color="bg-slate-50 text-slate-600" />
              <StatCard label="Errados" value={analysis.llamadaStats.find(s => s.name === 'Numero Errado')?.value || 0} icon={<AlertCircle size={20} />} color="bg-rose-50 text-rose-700" />
              <StatCard label={`Fuera ${surveyScope === 'regional' ? targetRegion : 'Región'}`} value={analysis.fueraRegion} icon={<Info size={20} />} color="bg-amber-50 text-amber-700" />
              
              <StatCard label="Con Mesa (Puesto)" value={analysis.conMesa} icon={<CheckCircle2 size={20} />} color="bg-emerald-50 text-emerald-700" />
              <StatCard label="% Con Mesa" value={((analysis.conMesa / analysis.total) * 100).toFixed(1) + '%'} icon={<PieIcon size={20} />} color="bg-emerald-50 text-emerald-700" />

              <StatCard label="Municipios" value={analysis.uniqueMunicipios} icon={<PieIcon size={20} />} color="bg-indigo-50 text-indigo-700" />
              <StatCard label="Sin Respuesta" value={analysis.sinRespuestaCount} icon={<AlertCircle size={20} />} color="bg-slate-50 text-slate-500" />
            </div>

            {/* Data Source Mapping Info */}
            <div className="mt-8 p-4 bg-slate-50 rounded-2xl border border-slate-100">
              <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
                <Info size={14} />
                Origen de los Datos (Columnas del Excel)
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] font-medium text-slate-400">Intención de Voto</span>
                  <span className="text-xs font-semibold text-slate-700 truncate" title={analysis.detectedColumns.encuesta}>
                    {analysis.detectedColumns.encuesta || "No detectada"}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] font-medium text-slate-400">Municipios</span>
                  <span className="text-xs font-semibold text-slate-700 truncate" title={analysis.detectedColumns.municipio}>
                    {analysis.detectedColumns.municipio || "No detectada"}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] font-medium text-slate-400">Departamento</span>
                  <span className="text-xs font-semibold text-slate-700 truncate" title={analysis.detectedColumns.departamento}>
                    {analysis.detectedColumns.departamento || "No detectada"}
                  </span>
                </div>
                <div className="flex flex-col gap-1">
                  <span className="text-[10px] font-medium text-slate-400">Estado Llamada</span>
                  <span className="text-xs font-semibold text-slate-700 truncate" title={analysis.detectedColumns.llamada}>
                    {analysis.detectedColumns.llamada || "No detectada"}
                  </span>
                </div>
              </div>
            </div>

            {/* Vote Intention Section */}
            <div className="flex flex-col gap-8 mt-8">
              <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100">
                <div className="flex flex-col gap-1 mb-6">
                  <div className="flex items-center gap-2">
                    <BarChart3 size={18} style={{ color: reportColor }} />
                    <h3 className="font-bold text-slate-800">Intención de Voto (Candidatos)</h3>
                  </div>
                  {analysis.detectedColumns.encuesta && (
                    <p className="text-[10px] text-slate-500 flex items-center gap-1 mt-1">
                      <span className="font-semibold">Columna:</span> 
                      <span className="bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200 text-slate-600 italic">
                        "{analysis.detectedColumns.encuesta}"
                      </span>
                    </p>
                  )}
                </div>
                <div style={{ height: `${Math.max(400, (analysis.candidateStats?.length || 0) * 45)}px` }}>
                  {analysis.candidateStats.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-slate-400">
                      <BarChart3 size={32} className="mb-2 opacity-20" />
                      <p className="text-sm italic">No se detectó intención de voto</p>
                      <p className="text-[10px] mt-1">Verifica la columna de candidatos</p>
                    </div>
                  ) : (
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart 
                        data={analysis.candidateStats} 
                        layout="vertical" 
                        margin={{ left: 20, right: 60, top: 10, bottom: 10 }}
                      >
                        <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
                        <XAxis 
                          type="number"
                          axisLine={false} 
                          tickLine={false} 
                          tick={{fill: '#64748b', fontSize: 11}} 
                          hide={true}
                        />
                        <YAxis 
                          dataKey="name" 
                          type="category"
                          axisLine={false} 
                          tickLine={false} 
                          tick={{fill: '#1e293b', fontSize: 12, fontWeight: 600}} 
                          width={180}
                          tickFormatter={(val) => val.length > 25 ? val.substring(0, 22) + '...' : val}
                        />
                        <Tooltip 
                          cursor={{fill: '#f1f5f9'}}
                          contentStyle={{ borderRadius: '12px', border: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.1)' }}
                        />
                        <Bar dataKey="value" radius={[0, 6, 6, 0]} barSize={28} minPointSize={3}>
                          {analysis.candidateStats.map((entry, index) => (
                            <Cell key={`cell-candidate-${index}`} fill={candidateColors[entry.name] || COLORS[index % COLORS.length]} />
                          ))}
                          <LabelList 
                            dataKey="value" 
                            position="right" 
                            style={{ fill: '#1e293b', fontSize: 13, fontWeight: 700 }} 
                            offset={15}
                            formatter={(val: any) => {
                              // Use total records for percentage to reflect the full 568 records
                              const total = analysis?.total || 1;
                              const pct = ((Number(val) / total) * 100).toFixed(1);
                              return `${val} (${pct}%)`;
                            }}
                          />
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>
              </div>

              <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100">
                <div className="flex items-center gap-2 mb-6">
                  <Info size={18} style={{ color: reportColor }} />
                  <h3 className="font-bold text-slate-800">Distribución por Municipios (%)</h3>
                </div>
                <div className="h-[350px] overflow-y-auto pr-2 custom-scrollbar">
                  <div className="space-y-3">
                    {analysis.municipioStats.length === 0 && (
                      <div className="flex flex-col items-center justify-center h-full py-10 text-slate-400">
                        <MapPin size={32} className="mb-2 opacity-20" />
                        <p className="text-sm italic">No se detectaron municipios</p>
                        <p className="text-[10px] mt-1">Verifica los encabezados de tu Excel</p>
                      </div>
                    )}
                    {analysis.municipioStats.slice(0, 15).map((m, i) => (
                      <div key={i} className="space-y-1">
                        <div className="flex justify-between text-xs font-medium text-slate-700">
                          <span>{m.name}</span>
                          <span>{m.percentage.toFixed(1)}% ({m.value})</span>
                        </div>
                        <div className="w-full bg-slate-200 rounded-full h-1.5">
                          <div 
                            className="h-1.5 rounded-full transition-all duration-500" 
                            style={{ width: `${m.percentage}%`, backgroundColor: reportColor }}
                          ></div>
                        </div>
                      </div>
                    ))}
                    {analysis.municipioStats.length > 15 && (
                      <p className="text-[10px] text-slate-400 text-center pt-2 italic">Mostrando los 15 municipios con mayor presencia.</p>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Charts Section */}
            <div className="mt-8">
              <div className="bg-slate-50 p-6 rounded-2xl border border-slate-100">
                <div className="flex items-center gap-2 mb-6">
                  <BarChart3 size={18} style={{ color: reportColor }} />
                  <h3 className="font-bold text-slate-800">Efectividad de Llamadas</h3>
                </div>
                <div className="h-[300px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={analysis.llamadaStats} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
                      <XAxis type="number" axisLine={false} tickLine={false} tick={{fill: '#64748b', fontSize: 12}} />
                      <YAxis dataKey="name" type="category" axisLine={false} tickLine={false} tick={{fill: '#64748b', fontSize: 12}} width={120} />
                      <Tooltip cursor={{fill: '#f1f5f9'}} />
                      <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                        {analysis.llamadaStats.map((entry, index) => (
                          <Cell key={`cell-call-${index}`} fill={COLORS[(index + 2) % COLORS.length]} />
                        ))}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>
            </div>

            {/* AI Analysis Section */}
            <div className="mt-8 p-8 rounded-3xl border" style={{ backgroundColor: `${reportColor}10`, borderColor: `${reportColor}30` }}>
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 text-white rounded-xl flex items-center justify-center" style={{ backgroundColor: reportColor }}>
                  <Info size={24} />
                </div>
                <div>
                  <h3 className="text-xl font-bold text-slate-900">Análisis e Interpretación de Datos</h3>
                  <p className="text-sm font-medium" style={{ color: reportColor }}>Generado por Inteligencia Artificial Gemini</p>
                </div>
              </div>
              <div className="prose prose-slate max-w-none text-slate-700 leading-relaxed">
                <ReactMarkdown>{analysis.aiInsight}</ReactMarkdown>
              </div>
            </div>

            {/* Data Preview */}
            <div className="mt-8 pt-8 border-t border-slate-100">
              <h3 className="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2">
                <FileText size={18} style={{ color: reportColor }} />
                Vista Previa de Columnas Detectadas
              </h3>
              <div className="overflow-x-auto rounded-xl border border-slate-200">
                <table className="w-full text-sm text-left text-slate-500">
                  <thead className="text-xs text-slate-700 uppercase bg-slate-50">
                    <tr>
                      {analysis.headers.slice(0, 8).map((h, i) => (
                        <th key={i} className="px-4 py-3 font-semibold whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.slice(0, 3).map((row, i) => (
                      <tr key={i} className="bg-white border-b border-slate-100 last:border-0">
                        {analysis.headers.slice(0, 8).map((h, j) => (
                          <td key={j} className="px-4 py-3 truncate max-w-[150px]">{String(row[h] || '')}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] text-slate-400 mt-2 italic">* Se muestran las primeras 3 filas y 8 columnas para referencia del análisis.</p>
            </div>

            {/* Footer of Report */}
            <div className="mt-12 pt-6 border-t border-slate-100 text-center text-slate-400 text-xs">
              Este informe fue generado el {new Date().toLocaleDateString()} a las {new Date().toLocaleTimeString()}.
              <br />
              Reporteador Estadístico Pro - Herramienta de Análisis Inteligente.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, icon, color }: { label: string; value: string | number; icon: React.ReactNode; color: string }) {
  return (
    <div className={cn("p-4 rounded-2xl flex items-center gap-4 transition-all hover:scale-[1.02]", color)}>
      <div className="shrink-0">
        {icon}
      </div>
      <div>
        <p className="text-xs font-semibold uppercase tracking-wider opacity-70">{label}</p>
        <p className="text-2xl font-bold">{value}</p>
      </div>
    </div>
  );
}
