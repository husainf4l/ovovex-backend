import { Injectable } from '@nestjs/common';
import { AccountsService } from 'src/accounts/accounts.service';
import { ClientsService } from 'src/clients/clients.service';
import { EmployeesService } from 'src/employees/employees.service';
import { JournalEntryService } from 'src/journal-entry/journal-entry.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { CreateReceiptDto } from './dto/CreateReceiptDto';

@Injectable()
export class ReceiptService {
  constructor(
    private readonly clientsService: ClientsService,
    private readonly journalService: JournalEntryService,
    private readonly employeeService: EmployeesService,
    private readonly accountsService: AccountsService,
    private readonly prisma: PrismaService,
  ) { }

  async getReceiptData() {
    const [clients, accountManagers, cashAccounts, receiptNumber] =
      await Promise.all([
        this.clientsService.getClients(),
        this.employeeService.getAccountManagers(),
        this.accountsService.getAccountsUnderCode('1.1.1'),
        this.getNextReceiptNumber(),
      ]);

    return { clients, accountManagers, cashAccounts, receiptNumber };
  }

  private async getNextReceiptNumber() {
    const lastReceipt = await this.prisma.receipt.findFirst({
      orderBy: { receiptNumber: 'desc' },
      select: { receiptNumber: true },
    });

    return (lastReceipt?.receiptNumber || 0) + 1;
  }

  async createReceipt(createReceiptDto: CreateReceiptDto) {
    const {
      cheques,
      clientId,
      accountManagerId,
      TransactionAccountId,
      ...receiptData
    } = createReceiptDto;

    console.log(createReceiptDto);
    // Ensure customer exists
    const customer = await this.prisma.customer.findUnique({
      where: { accountId: clientId },
      select: { id: true },
    });

    if (!customer) {
      throw new Error('Customer not found');
    }

    // Fetch the last receipt number and increment it
    const lastReceipt = await this.prisma.receipt.findFirst({
      orderBy: { receiptNumber: 'desc' },
      select: { receiptNumber: true },
    });

    const nextReceiptNumber = lastReceipt ? lastReceipt.receiptNumber + 1 : 1;

    const receipt = await this.prisma.receipt.create({
      data: {
        ...receiptData,
        accountId: clientId, // Directly assigning the customerId
        customerId: customer.id,
        accountManagerId: accountManagerId || null, // Optional, can be null
        TransactionAccountId: TransactionAccountId || null, // Optional, can be null
        receiptNumber: nextReceiptNumber, // Use the incremented receipt number
        chequeDetails: {
          create: cheques.map((cheque) => ({
            chequeNumber: cheque.chequeNumber,
            bankName: cheque.bankName,
            amount: cheque.amount,
            date: new Date(cheque.date),
          })),
        },
      },
      include: {
        chequeDetails: true,
        customer: true,
        accountManager: true,
      },
    });
    // Prepare transaction data for the journal entry
    const transactions = [
      {
        accountId: TransactionAccountId, // Debit Cash Account
        debit: receipt.totalAmount, // Debit the total amount
        credit: null,
        currency: 'JOD',
        notes: `Receipt payment for client ${clientId}`,
      },
      {
        accountId: clientId, // Credit Client Account
        debit: null,
        credit: receipt.totalAmount, // Credit the total amount
        currency: 'JOD',
        notes: `Payment received from client ${clientId}`,
      },
    ];

    const journalEntry = await this.journalService.createJournalEntry({
      date: new Date(),
      transactions: transactions,
    });

    return receipt;
  }

  async getReceiptList() {
    return this.prisma.receipt.findMany({ include: { customer: true } });
  }
}
