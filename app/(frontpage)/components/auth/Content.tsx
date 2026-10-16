import { FileText, MessageCircle, BookOpen, History } from 'lucide-react';

const items = [
  {
    icon: <FileText className="h-5 w-5 text-muted-foreground" />,
    title: 'Upload PDFs',
    description:
      'Upload a PDF and wait for its status to show Ready before asking questions.'
  },
  {
    icon: <MessageCircle className="h-5 w-5 text-muted-foreground" />,
    title: 'Ask document questions',
    description: 'Ask questions about the content of your ready documents.'
  },
  {
    icon: <BookOpen className="h-5 w-5 text-muted-foreground" />,
    title: 'Review sources',
    description:
      'Follow citations to review the referenced physical pages in your PDFs.'
  },
  {
    icon: <History className="h-5 w-5 text-muted-foreground" />,
    title: 'Saved chats',
    description:
      'Revisit your own saved conversations to review earlier questions and answers.'
  }
];

export default function Content() {
  return (
    <div className="flex flex-col self-center gap-8 max-w-[450px]">
      {items.map((item, index) => (
        <div key={index} className="flex gap-4">
          <div className="flex-shrink-0 mt-0.5">{item.icon}</div>
          <div>
            <h3 className="font-medium mb-1.5">{item.title}</h3>
            <p className="text-sm text-muted-foreground">{item.description}</p>
          </div>
        </div>
      ))}
    </div>
  );
}
