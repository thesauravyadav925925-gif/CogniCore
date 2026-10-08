import EvidencePanel from './EvidencePanel';
import AutoChart from './AutoChart';
import InsightsBlock from './InsightsBlock';
import { Badges, ReportCard, ActionCard, ConfidenceBlock, ProvenanceBlock, QualityWarnings, TraceSummary } from './MessageExtras';

export default function MessageBubble({ message, datasetId, onAsk, onOpenActions, onOpenTrace }) {
  const isUser = message.role === 'user';

  return (
    <div className={`message-row ${isUser ? 'message-row-user' : 'message-row-assistant'}`}>
      <div className={`message-avatar ${isUser ? 'avatar-user' : 'avatar-assistant'}`}>
        {isUser ? 'U' : 'CC'}
      </div>
      <div className="message-content">
        <div className={`message-bubble ${isUser ? 'bubble-user' : 'bubble-assistant'} ${message.pending ? 'bubble-pending' : ''} ${message.isError ? 'bubble-error' : ''}`}>
          {message.pending ? (
            <span className="thinking-dots"><span /><span /><span /></span>
          ) : (
            message.content
          )}
        </div>
        {!isUser && !message.pending && (
          <>
            <Badges message={message} />
            <QualityWarnings warnings={message.qualityWarnings} />
            <ReportCard report={message.report} />
            <ActionCard action={message.action} onOpenActions={onOpenActions} />
            <AutoChart chart={message.chart} datasetId={datasetId} sql={message.generatedSql} question={message.question} />
            <InsightsBlock insights={message.insights} suggestions={message.suggestions} onAsk={onAsk} />
            <ConfidenceBlock confidence={message.confidence} />
            <ProvenanceBlock provenance={message.provenance} />
            <TraceSummary trace={message.trace} onOpen={onOpenTrace} />
          </>
        )}
        {!isUser && !message.pending && (
          <EvidencePanel evidence={message.evidence} generatedSql={message.generatedSql} question={message.question} answer={message.content} />
        )}
      </div>
    </div>
  );
}
