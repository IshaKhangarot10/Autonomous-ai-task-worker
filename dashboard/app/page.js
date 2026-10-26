'use client';

import { useState, useEffect, useRef } from 'react';

const AGENT_API = process.env.NEXT_PUBLIC_AGENT_URL || 'http://localhost:4001';

const EXAMPLE_TASKS = [
  {
    title: 'Task 1: Latest Globex Invoice',
    prompt: 'Find the latest invoice from Globex, extract the amount and due date, enter it into the finance portal, and tell me once it is done.'
  },
  {
    title: 'Task 2: Initech (Indian Numbering)',
    prompt: 'Enter the Initech invoice from the inbox into the portal.'
  },
  {
    title: 'Task 3: Duplicate Detection (INV-2041)',
    prompt: 'Log the invoice in the inbox with number INV-2041.'
  },
  {
    title: 'Task 4: Update Vendor Email',
    prompt: "Update Initech's billing email to accounts@initech.example in the vendor records."
  },
  {
    title: 'Task 5: Vendor Ambiguity',
    prompt: 'Enter the Acme invoice.'
  }
];

export default function Dashboard() {
  const [goal, setGoal] = useState('');
  const [currentRunId, setCurrentRunId] = useState(null);
  const [isRunning, setIsRunning] = useState(false);
  const [serverOnline, setServerOnline] = useState(false);

  // Live state
  const [steps, setSteps] = useState([]);
  const [plan, setPlan] = useState([]);
  const [memory, setMemory] = useState({});
  const [finalResult, setFinalResult] = useState(null);

  // Intervention states
  const [pendingApproval, setPendingApproval] = useState(null);
  const [approvalComment, setApprovalComment] = useState('');
  const [pendingQuestion, setPendingQuestion] = useState(null);
  const [humanAnswer, setHumanAnswer] = useState('');

  // Past runs
  const [pastRuns, setPastRuns] = useState([]);
  const [expandedStep, setExpandedStep] = useState(null);

  const eventSourceRef = useRef(null);
  const stepsEndRef = useRef(null);

  // 1. Check agent server health and fetch past runs
  const fetchPastRuns = async () => {
    try {
      const res = await fetch(`${AGENT_API}/api/runs`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        const data = await res.json();
        setPastRuns(Array.isArray(data) ? data : []);
        setServerOnline(true);
      } else {
        setServerOnline(false);
      }
    } catch (_) {
      setServerOnline(false);
    }
  };

  useEffect(() => {
    fetchPastRuns();
    const interval = setInterval(fetchPastRuns, 5000);
    return () => clearInterval(interval);
  }, []);

  // 2. Connect to SSE stream when currentRunId changes
  useEffect(() => {
    if (!currentRunId) return;

    if (eventSourceRef.current) {
      eventSourceRef.current.close();
    }

    const es = new EventSource(`${AGENT_API}/api/runs/${currentRunId}/events`);
    eventSourceRef.current = es;

    es.onmessage = e => {
      try {
        const data = JSON.parse(e.data);

        if (data.type === 'step') {
          setSteps(prev => {
            // Avoid duplicates
            if (prev.some(s => s.index === data.step.index)) return prev;
            return [...prev, data.step];
          });
          if (data.plan) setPlan(data.plan);
          if (data.memory) setMemory(data.memory);
        } else if (data.type === 'plan_updated') {
          if (data.plan) setPlan(data.plan);
        } else if (data.type === 'memory_updated') {
          if (data.memory) setMemory(data.memory);
        } else if (data.type === 'approval_required') {
          setPendingApproval(data);
        } else if (data.type === 'approval_resolved') {
          setPendingApproval(null);
          setApprovalComment('');
        } else if (data.type === 'human_question') {
          setPendingQuestion(data);
        } else if (data.type === 'question_answered') {
          setPendingQuestion(null);
          setHumanAnswer('');
        } else if (data.type === 'task_finished') {
          setIsRunning(false);
          setFinalResult(data);
          fetchPastRuns();
        }
      } catch (_) {}
    };

    es.onerror = () => {
      // Stream closed or error
    };

    return () => {
      es.close();
    };
  }, [currentRunId]);

  // Auto-scroll to bottom of steps
  useEffect(() => {
    stepsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [steps]);

  // 3. Start a new run
  const handleStartRun = async taskGoal => {
    const targetGoal = taskGoal || goal;
    if (!targetGoal.trim()) return;

    setIsRunning(true);
    setSteps([]);
    setPlan([]);
    setMemory({});
    setFinalResult(null);
    setPendingApproval(null);
    setPendingQuestion(null);

    try {
      const res = await fetch(`${AGENT_API}/api/runs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: targetGoal })
      });

      if (!res.ok) {
        throw new Error(`Server returned ${res.status}`);
      }

      const data = await res.json();
      setCurrentRunId(data.runId);
    } catch (err) {
      alert(`Could not start run: ${err.message}. Ensure the agent server is running on http://localhost:4001 (npm run agent).`);
      setIsRunning(false);
    }
  };

  // 4. Handle supervisor approval
  const handleApprovalDecision = async approved => {
    if (!currentRunId) return;
    try {
      await fetch(`${AGENT_API}/api/runs/${currentRunId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved, reason: approvalComment || undefined })
      });
      setPendingApproval(null);
      setApprovalComment('');
    } catch (err) {
      alert(`Failed to submit approval: ${err.message}`);
    }
  };

  // 5. Handle supervisor question answer
  const handleAnswerSubmit = async answerText => {
    const answer = answerText || humanAnswer;
    if (!currentRunId || !answer.trim()) return;

    try {
      await fetch(`${AGENT_API}/api/runs/${currentRunId}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer })
      });
      setPendingQuestion(null);
      setHumanAnswer('');
    } catch (err) {
      alert(`Failed to submit answer: ${err.message}`);
    }
  };

  // 6. Load a past run
  const handleSelectPastRun = async runId => {
    try {
      const res = await fetch(`${AGENT_API}/api/runs/${runId}`);
      if (res.ok) {
        const data = await res.json();
        setCurrentRunId(runId);
        setIsRunning(data.run?.status === 'running');
        setGoal(data.run?.goal || '');
        setSteps(data.steps || []);
        setPlan(data.run?.plan || []);
        setMemory(data.run?.memory || {});
        setFinalResult({
          status: data.run?.status,
          summary: data.run?.summary,
          claimedOutcome: data.run?.claimedOutcome,
          stepCount: data.run?.stepCount,
          verification: data.run?.verification
        });
      }
    } catch (_) {}
  };

  const getPhaseColor = phase => {
    switch (phase) {
      case 'understand': return 'bg-blue-100 text-blue-800 border-blue-300';
      case 'plan': return 'bg-purple-100 text-purple-800 border-purple-300';
      case 'observe': return 'bg-cyan-100 text-cyan-800 border-cyan-300';
      case 'execute': return 'bg-emerald-100 text-emerald-800 border-emerald-300';
      case 'adapt': return 'bg-amber-100 text-amber-800 border-amber-300';
      case 'verify': return 'bg-indigo-100 text-indigo-800 border-indigo-300';
      case 'complete': return 'bg-green-100 text-green-800 border-green-300';
      default: return 'bg-gray-100 text-gray-800 border-gray-300';
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 flex flex-col font-sans">
      {/* ── Top Header ── */}
      <header className="bg-white border-b border-slate-200 px-6 py-4 flex items-center justify-between sticky top-0 z-20 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-bold text-sm shadow">
            CA
          </div>
          <div>
            <h1 className="font-bold text-lg text-slate-900 leading-tight">CentrAlign AI</h1>
            <p className="text-xs text-slate-500">Autonomous AI Task Worker Prototype</p>
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs">
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${serverOnline ? 'bg-emerald-500' : 'bg-red-500'}`}></span>
            <span className="text-slate-600 font-medium">
              {serverOnline ? 'Agent Server Online (:4001)' : 'Agent Server Offline'}
            </span>
          </div>

          {currentRunId && (
            <div className="bg-slate-100 px-2.5 py-1 rounded border border-slate-300 font-mono text-slate-700">
              Run: {currentRunId}
            </div>
          )}
        </div>
      </header>

      {/* ── Main Container ── */}
      <main className="flex-1 max-w-7xl w-full mx-auto p-6 flex flex-col gap-6">

        {/* ── Task Input & Example Chips ── */}
        <section className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
          <label htmlFor="task-goal" className="block text-sm font-semibold text-slate-800 mb-2">
            Give the AI Task Worker an Instruction:
          </label>
          <div className="flex gap-3">
            <textarea
              id="task-goal"
              rows={2}
              value={goal}
              onChange={e => setGoal(e.target.value)}
              placeholder="e.g. Find the latest invoice from Globex, extract the amount and due date, enter it into the finance portal, and tell me once it is done."
              className="flex-1 p-3 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
            />
            <button
              id="run-task-btn"
              onClick={() => handleStartRun()}
              disabled={isRunning || !goal.trim() || !serverOnline}
              className={`px-6 rounded-lg font-semibold text-sm transition-colors flex items-center justify-center ${
                isRunning
                  ? 'bg-slate-300 text-slate-500 cursor-not-allowed'
                  : 'bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm'
              }`}
            >
              {isRunning ? 'Running…' : 'Run Task'}
            </button>
          </div>

          {/* Example task chips */}
          <div className="mt-3 flex flex-wrap gap-2 items-center">
            <span className="text-xs font-medium text-slate-500">Quick Tasks:</span>
            {EXAMPLE_TASKS.map((t, idx) => (
              <button
                key={idx}
                onClick={() => {
                  setGoal(t.prompt);
                  handleStartRun(t.prompt);
                }}
                disabled={isRunning}
                className="text-xs bg-slate-100 hover:bg-indigo-50 hover:text-indigo-700 text-slate-700 border border-slate-200 rounded-full px-3 py-1 transition-colors"
              >
                {t.title}
              </button>
            ))}
          </div>
        </section>

        {/* ── Interactive Intervention Cards (Pinned on Top when Active) ── */}

        {/* 1. Approval Card */}
        {pendingApproval && (
          <div className="bg-amber-50 border-2 border-amber-400 rounded-xl p-5 shadow-md">
            <div className="flex items-center gap-2 text-amber-800 font-bold mb-2">
              <span className="text-lg">⚠️</span>
              <h2>Human-in-the-Loop: Action Approval Required</h2>
            </div>
            <p className="text-sm text-amber-900 mb-3">
              The agent is requesting supervisor approval before executing a mutating action:
            </p>

            <div className="bg-white rounded-lg border border-amber-200 p-3 mb-3 text-xs font-mono">
              <div><strong>Tool:</strong> {pendingApproval.tool}</div>
              <div><strong>Arguments:</strong> {JSON.stringify(pendingApproval.args)}</div>
            </div>

            {pendingApproval.screenshot && (
              <div className="mb-3">
                <span className="text-xs font-semibold text-amber-900 block mb-1">Current Form State:</span>
                <img
                  src={`${AGENT_API}${pendingApproval.screenshot}`}
                  alt="Form screenshot"
                  className="rounded border border-amber-300 max-h-56 object-contain bg-white"
                />
              </div>
            )}

            <div className="flex flex-col gap-2">
              <input
                type="text"
                value={approvalComment}
                onChange={e => setApprovalComment(e.target.value)}
                placeholder="Optional feedback or rejection comment…"
                className="text-xs p-2 border border-amber-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-amber-500"
              />
              <div className="flex gap-2">
                <button
                  onClick={() => handleApprovalDecision(true)}
                  className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs rounded shadow"
                >
                  ✓ Approve Action
                </button>
                <button
                  onClick={() => handleApprovalDecision(false)}
                  className="px-4 py-2 bg-rose-600 hover:bg-rose-700 text-white font-semibold text-xs rounded shadow"
                >
                  ✕ Reject Action
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 2. Clarification Card */}
        {pendingQuestion && (
          <div className="bg-blue-50 border-2 border-blue-400 rounded-xl p-5 shadow-md">
            <div className="flex items-center gap-2 text-blue-800 font-bold mb-2">
              <span className="text-lg">❓</span>
              <h2>Agent Clarification Needed</h2>
            </div>
            <p className="text-sm text-blue-900 mb-3 font-medium">
              {pendingQuestion.question}
            </p>

            {pendingQuestion.options && pendingQuestion.options.length > 0 && (
              <div className="flex flex-wrap gap-2 mb-3">
                {pendingQuestion.options.map((opt, idx) => (
                  <button
                    key={idx}
                    onClick={() => handleAnswerSubmit(opt)}
                    className="px-3 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg shadow-sm"
                  >
                    {opt}
                  </button>
                ))}
              </div>
            )}

            <div className="flex gap-2">
              <input
                type="text"
                value={humanAnswer}
                onChange={e => setHumanAnswer(e.target.value)}
                placeholder="Type your response to the agent…"
                className="flex-1 text-xs p-2.5 border border-blue-300 rounded bg-white focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <button
                onClick={() => handleAnswerSubmit()}
                disabled={!humanAnswer.trim()}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white font-semibold text-xs rounded shadow"
              >
                Submit Response
              </button>
            </div>
          </div>
        )}

        {/* ── Two-Column Execution View ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">

          {/* Left Column: Live Steps Timeline (2 Columns wide on LG) */}
          <section className="lg:col-span-2 flex flex-col gap-4">

            {/* Final Outcome Banner */}
            {finalResult && (
              <div className={`p-5 rounded-xl border shadow-sm ${
                finalResult.status === 'completed'
                  ? 'bg-emerald-50 border-emerald-300 text-emerald-950'
                  : finalResult.status === 'blocked'
                  ? 'bg-amber-50 border-amber-300 text-amber-950'
                  : 'bg-rose-50 border-rose-300 text-rose-950'
              }`}>
                <div className="flex items-center justify-between mb-2">
                  <span className="font-bold text-base uppercase tracking-wider flex items-center gap-1.5">
                    {finalResult.status === 'completed' ? '✓ TASK COMPLETED' : finalResult.status === 'blocked' ? '⏸ TASK BLOCKED' : '✕ TASK FAILED'}
                  </span>
                  <span className="text-xs font-mono bg-white/70 px-2 py-0.5 rounded border border-current">
                    {finalResult.stepCount || steps.length} steps
                  </span>
                </div>
                <p className="text-sm leading-relaxed mb-3">{finalResult.summary}</p>

                {/* Claimed Outcome breakdown */}
                {finalResult.claimedOutcome && Object.keys(finalResult.claimedOutcome).length > 0 && (
                  <div className="bg-white/80 rounded-lg p-3 text-xs mb-3 font-mono border border-current/20">
                    <strong className="block mb-1 text-slate-800">Claimed Outcome:</strong>
                    <pre className="overflow-x-auto">{JSON.stringify(finalResult.claimedOutcome, null, 2)}</pre>
                  </div>
                )}

                {/* Independent Verification Table */}
                {finalResult.verification?.checks && (
                  <div className="mt-3 bg-white rounded-lg p-3 border border-emerald-300">
                    <strong className="block text-xs font-bold text-emerald-900 mb-2">
                      Independent Verification Pass ({finalResult.verification.verified ? 'VERIFIED ✓' : 'FAILED ✕'}):
                    </strong>
                    <table className="w-full text-xs text-left">
                      <thead>
                        <tr className="border-b text-slate-500">
                          <th className="py-1">Check</th>
                          <th className="py-1">Expected</th>
                          <th className="py-1">Actual</th>
                          <th className="py-1 text-right">Result</th>
                        </tr>
                      </thead>
                      <tbody>
                        {finalResult.verification.checks.map((chk, i) => (
                          <tr key={i} className="border-b last:border-0">
                            <td className="py-1 font-medium">{chk.what}</td>
                            <td className="py-1 font-mono text-slate-600">{String(chk.expected)}</td>
                            <td className="py-1 font-mono text-slate-600">{String(chk.actual)}</td>
                            <td className="py-1 text-right">
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${chk.pass ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'}`}>
                                {chk.pass ? 'PASS' : 'FAIL'}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}

            {/* Steps Timeline Header */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
              <div className="flex items-center justify-between mb-4 border-b pb-3">
                <h2 className="font-bold text-slate-900 flex items-center gap-2">
                  <span>Live Execution Timeline</span>
                  <span className="text-xs bg-slate-100 text-slate-600 px-2 py-0.5 rounded-full font-mono">
                    {steps.length} steps
                  </span>
                </h2>
                {isRunning && (
                  <span className="text-xs font-medium text-indigo-600 animate-pulse flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-indigo-600"></span>
                    Worker executing…
                  </span>
                )}
              </div>

              {steps.length === 0 ? (
                <div className="py-12 text-center text-slate-400 text-sm">
                  {isRunning ? 'Initiating run and browser environment…' : 'Enter an instruction above or click a quick task to start.'}
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  {steps.map(step => (
                    <div
                      key={step.index}
                      className="border border-slate-200 rounded-lg p-3 hover:border-slate-300 transition-colors bg-white text-xs"
                    >
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-2">
                          <span className="font-bold font-mono text-slate-700">#{step.index}</span>
                          <span className={`px-2 py-0.5 rounded border text-[10px] font-bold uppercase tracking-wider ${getPhaseColor(step.phase)}`}>
                            {step.phase}
                          </span>
                          <span className="font-semibold text-slate-900">{step.tool}</span>
                        </div>
                        <span className="text-[11px] text-slate-400 font-mono">{step.durationMs}ms</span>
                      </div>

                      <p className="text-slate-700 mb-2 font-medium">{step.resultSummary}</p>

                      {/* Inline screenshot thumbnail */}
                      {step.screenshot && (
                        <div className="mb-2">
                          <a
                            href={`${AGENT_API}/${step.screenshot}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-block border border-slate-200 rounded overflow-hidden shadow-sm hover:opacity-90"
                          >
                            <img
                              src={`${AGENT_API}/${step.screenshot}`}
                              alt="Step artifact"
                              className="h-28 object-cover"
                            />
                          </a>
                        </div>
                      )}

                      {/* Expandable JSON details */}
                      <button
                        onClick={() => setExpandedStep(expandedStep === step.index ? null : step.index)}
                        className="text-[11px] text-indigo-600 hover:text-indigo-800 font-medium"
                      >
                        {expandedStep === step.index ? '▾ Hide Details' : '▸ View Args & Result'}
                      </button>

                      {expandedStep === step.index && (
                        <div className="mt-2 p-2 bg-slate-50 border rounded font-mono text-[10px] text-slate-700 overflow-x-auto space-y-1">
                          <div><strong>Args:</strong> {JSON.stringify(step.args, null, 2)}</div>
                          <div><strong>Result:</strong> {JSON.stringify(step.result, null, 2)}</div>
                        </div>
                      )}
                    </div>
                  ))}
                  <div ref={stepsEndRef} />
                </div>
              )}
            </div>
          </section>

          {/* Right Column: Plan Checklist, Memory & Past Runs */}
          <aside className="flex flex-col gap-6">

            {/* Plan Checklist */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
              <h3 className="font-bold text-slate-900 text-sm mb-3 flex items-center justify-between">
                <span>Multi-Step Plan</span>
                <span className="text-xs font-mono text-slate-500">{plan.filter(s => s.status === 'completed').length}/{plan.length}</span>
              </h3>

              {plan.length === 0 ? (
                <p className="text-xs text-slate-400">Plan will appear once the worker calls update_plan.</p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {plan.map(p => (
                    <li key={p.id} className="text-xs flex items-start gap-2">
                      <span className={`w-4 h-4 rounded-full flex items-center justify-center text-[10px] font-bold mt-0.5 shrink-0 ${
                        p.status === 'completed'
                          ? 'bg-emerald-100 text-emerald-800'
                          : p.status === 'in_progress'
                          ? 'bg-indigo-100 text-indigo-800 animate-pulse'
                          : 'bg-slate-100 text-slate-400'
                      }`}>
                        {p.status === 'completed' ? '✓' : p.status === 'in_progress' ? '▶' : '○'}
                      </span>
                      <span className={`${p.status === 'completed' ? 'line-through text-slate-400' : 'text-slate-800 font-medium'}`}>
                        {p.description}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {/* Working Memory Panel */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
              <h3 className="font-bold text-slate-900 text-sm mb-3">Extracted Working Memory</h3>

              {Object.keys(memory).length === 0 ? (
                <p className="text-xs text-slate-400">Extracted facts (invoices, dates, amounts) will appear here via remember().</p>
              ) : (
                <div className="space-y-1.5 text-xs">
                  {Object.entries(memory).map(([key, val]) => (
                    <div key={key} className="bg-slate-50 border rounded p-2">
                      <span className="font-mono text-indigo-700 font-semibold block">{key}</span>
                      <span className="font-mono text-slate-800 text-[11px] break-all">{JSON.stringify(val)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Past Runs History */}
            <div className="bg-white rounded-xl border border-slate-200 p-5 shadow-sm">
              <h3 className="font-bold text-slate-900 text-sm mb-3">Run History (MongoDB)</h3>

              {pastRuns.length === 0 ? (
                <p className="text-xs text-slate-400">No past runs recorded yet.</p>
              ) : (
                <div className="flex flex-col gap-2 max-h-72 overflow-y-auto">
                  {pastRuns.map(run => (
                    <button
                      key={run.runId}
                      onClick={() => handleSelectPastRun(run.runId)}
                      className={`text-left p-2.5 rounded-lg border text-xs transition-colors ${
                        run.runId === currentRunId
                          ? 'bg-indigo-50 border-indigo-300'
                          : 'hover:bg-slate-50 border-slate-200'
                      }`}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-mono font-semibold text-[11px] text-slate-700">{run.runId.slice(0, 16)}…</span>
                        <span className={`px-1.5 py-0.2 rounded text-[9px] font-bold uppercase ${
                          run.status === 'completed' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'
                        }`}>
                          {run.status}
                        </span>
                      </div>
                      <p className="text-slate-600 text-[11px] line-clamp-2">{run.goal}</p>
                    </button>
                  ))}
                </div>
              )}
            </div>

          </aside>
        </div>
      </main>
    </div>
  );
}
